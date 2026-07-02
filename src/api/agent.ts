import express, { type Express } from "express";
import type { AppConfig } from "../utils/config.js";
import { Orchestrator, OrchestratorError } from "../core/orchestrator.js";
import { QueryRequestSchema } from "../types/index.js";
import {
  buildErrorResponse,
  buildSuccessResponse,
} from "../utils/formatters.js";

/**
 * HTTP surface. Always exposes GET /health. When ENABLE_DEV_ENDPOINT=true it
 * also exposes POST /agent/query, which drives the orchestrator + Telegram loop
 * WITHOUT CAP — payment metadata is returned as `pending`. This path is for
 * local testing only and must not carry paid production traffic.
 */
export function createApp(orchestrator: Orchestrator, config: AppConfig): Express {
  const app = express();
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "datayetu-agent", ts: new Date().toISOString() });
  });

  if (config.runtime.enableDevEndpoint) {
    app.post("/agent/query", async (req, res) => {
      const parsed = QueryRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res
          .status(400)
          .json(
            buildErrorResponse(
              "VALIDATION_ERROR",
              parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
            ),
          );
        return;
      }

      try {
        const { task, validator } = await orchestrator.handleQuery({
          query: parsed.data.query,
          caller_type: parsed.data.caller_type,
          caller_id: parsed.data.caller_id,
          max_price: parsed.data.max_price,
        });

        res.json(
          buildSuccessResponse(task, validator, {
            amount: String(parsed.data.max_price),
            currency: config.runtime.serviceCurrency,
            status: "pending",
            reference: `dev_${task.task_id}`,
          }),
        );
      } catch (err) {
        if (err instanceof OrchestratorError) {
          res
            .status(err.code === "NO_VALIDATOR_RESPONSE" ? 504 : 500)
            .json(
              buildErrorResponse(err.code, err.message, {
                task_id: err.taskId,
                order_id: err.orderId,
              }),
            );
          return;
        }
        res
          .status(500)
          .json(buildErrorResponse("INTERNAL_ERROR", (err as Error).message));
      }
    });
    console.log("[api] dev endpoint enabled: POST /agent/query (bypasses CAP)");
  }

  return app;
}
