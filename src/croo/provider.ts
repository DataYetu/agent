import {
  AgentClient,
  DeliverableType,
  EventType,
  type Event,
} from "@croo-network/sdk";
import type { AppConfig } from "../utils/config.js";
import type { Orchestrator } from "../core/orchestrator.js";
import { OrchestratorError } from "../core/orchestrator.js";
import { QueryRequestSchema, type QueryRequest } from "../types/index.js";
import { buildDeliveryPayload } from "../utils/formatters.js";
import { taskStore } from "../utils/taskStore.js";

/**
 * Wires the CAP order lifecycle to the orchestrator:
 *   NegotiationCreated -> validate + acceptNegotiation
 *   OrderCreated       -> early Telegram preview (escrow confirming)
 *   OrderPaid          -> dispatch to validators, then deliverOrder
 *   OrderCompleted     -> settlement cleared on-chain
 */
export class CrooProvider {
  private orderQueries = new Map<string, QueryRequest>();

  constructor(
    private readonly client: AgentClient,
    private readonly orchestrator: Orchestrator,
    private readonly config: AppConfig,
  ) {}

  async start(): Promise<void> {
    const stream = await this.client.connectWebSocket();

    stream.on(EventType.NegotiationCreated, (e: Event) => {
      void this.onNegotiationCreated(e);
    });
    stream.on(EventType.OrderCreated, (e: Event) => {
      void this.onOrderCreated(e);
    });
    stream.on(EventType.OrderPaid, (e: Event) => {
      void this.onOrderPaid(e);
    });
    stream.on(EventType.OrderCompleted, (e: Event) => {
      this.onOrderCompleted(e);
    });

    console.log("[croo] provider connected; awaiting negotiations");
  }

  private async onNegotiationCreated(e: Event): Promise<void> {
    const negotiationId = e.negotiation_id;
    if (!negotiationId) return;

    try {
      const negotiation = await this.client.getNegotiation(negotiationId);
      const parsed = this.extractQueryRequest(negotiation);

      if (!parsed) {
        await this.client.rejectNegotiation(
          negotiationId,
          "Missing query payload (expected requirements or metadata)",
        );
        return;
      }

      // Reject if the caller's ceiling is below our service price.
      if (parsed.max_price < this.config.runtime.servicePrice) {
        await this.client.rejectNegotiation(
          negotiationId,
          `max_price ${parsed.max_price} below service price ${this.config.runtime.servicePrice}`,
        );
        return;
      }

      // Prefer plain accept; if CROO says this is a fund service, retry with AA wallet.
      const result = await this.acceptNegotiationSmart(negotiationId);

      const orderId = result.order?.orderId;
      if (orderId) {
        this.orderQueries.set(orderId, {
          ...parsed,
          order_id: orderId,
          negotiation_id: negotiationId,
        });
        console.log(`[croo] accepted negotiation ${negotiationId} -> order ${orderId}`);
      }
    } catch (err) {
      console.error(
        `[croo] failed handling negotiation ${negotiationId}:`,
        (err as Error).message,
      );
    }
  }

  private async onOrderCreated(e: Event): Promise<void> {
    const orderId = e.order_id;
    if (!orderId) return;

    const request = this.orderQueries.get(orderId);
    if (!request) return;

    try {
      await this.orchestrator.notifyEscrowPending(orderId, request.query);
    } catch (err) {
      console.warn(
        `[croo] escrow preview for ${orderId} failed:`,
        (err as Error).message,
      );
    }
  }

  private async onOrderPaid(e: Event): Promise<void> {
    const orderId = e.order_id;
    if (!orderId) return;

    const request = await this.resolveOrderQuery(orderId);
    if (!request) {
      console.error(`[croo] no query context for paid order ${orderId}; rejecting`);
      await this.safeRejectOrder(orderId, "Missing query context");
      return;
    }

    console.log(`[croo] order ${orderId} paid; dispatching to validators`);

    try {
      const { task, validator } = await this.orchestrator.handleQuery({
        query: request.query,
        caller_type: request.caller_type,
        caller_id: request.caller_id,
        max_price: request.max_price,
        order_id: orderId,
        negotiation_id: request.negotiation_id,
      });

      const payload = buildDeliveryPayload(task, validator);
      const delivery = await this.client.deliverOrder(orderId, {
        deliverableType: DeliverableType.Text,
        deliverableText: JSON.stringify(payload),
      });
      taskStore.update(task.task_id, { status: "DELIVERED" });
      console.log(
        `[croo] delivered order ${orderId} (task ${task.task_id}) tx=${delivery.txHash}`,
      );
    } catch (err) {
      const reason =
        err instanceof OrchestratorError
          ? `${err.code}: ${err.message}`
          : (err as Error).message;
      console.error(`[croo] delivery failed for order ${orderId}: ${reason}`);
      await this.safeRejectOrder(orderId, reason);
    } finally {
      this.orderQueries.delete(orderId);
      this.orchestrator.clearEscrow(orderId);
    }
  }

  private onOrderCompleted(e: Event): void {
    const orderId = e.order_id;
    if (!orderId) return;
    console.log(`[croo] order ${orderId} completed; settlement cleared on-chain`);
  }

  /**
   * Returns the query context for an order, recovering it from the order's
   * negotiation requirements if the negotiation event was missed.
   */
  private async resolveOrderQuery(orderId: string): Promise<QueryRequest | undefined> {
    const cached = this.orderQueries.get(orderId);
    if (cached) return cached;

    try {
      const order = await this.client.getOrder(orderId);
      if (order.negotiationId) {
        const negotiation = await this.client.getNegotiation(order.negotiationId);
        const parsed = this.extractQueryRequest(negotiation);
        if (parsed) return { ...parsed, order_id: orderId, negotiation_id: order.negotiationId };
      }
    } catch (err) {
      console.error(`[croo] failed to recover query for ${orderId}:`, (err as Error).message);
    }
    return undefined;
  }

  private async safeRejectOrder(orderId: string, reason: string): Promise<void> {
    try {
      await this.client.rejectOrder(orderId, reason);
    } catch (err) {
      console.error(`[croo] rejectOrder failed for ${orderId}:`, (err as Error).message);
    }
  }

  private async acceptNegotiationSmart(negotiationId: string) {
    try {
      return await this.client.acceptNegotiation(negotiationId);
    } catch (err) {
      const message = (err as Error).message ?? "";
      const needsFund =
        /provider_fund_address/i.test(message) ||
        /fund service/i.test(message) ||
        /require_fund_transfer/i.test(message);
      if (!needsFund) throw err;

      const fundAddress = this.config.croo.providerFundAddress;
      if (!fundAddress) {
        throw new Error(
          `${message}. Set PROVIDER_FUND_ADDRESS to the agent AA wallet ` +
            `(CROO Dashboard → Configure), or turn OFF "Require Fund Transfer" ` +
            `for this oracle service.`,
        );
      }
      console.log(
        `[croo] fund-service accept for ${negotiationId}; providerFundAddress=${fundAddress}`,
      );
      return this.client.acceptNegotiationWithFundAddress(negotiationId, fundAddress);
    }
  }

  private extractQueryRequest(negotiation: {
    requirements?: string;
    metadata?: string;
    requesterAgentId?: string;
  }): QueryRequest | null {
    const fromRequirements = this.parseRequirementsPayload(
      negotiation.requirements,
      negotiation.requesterAgentId,
    );
    if (fromRequirements) return fromRequirements;

    const fromMetadata = this.parseRequirementsPayload(
      negotiation.metadata,
      negotiation.requesterAgentId,
    );
    if (fromMetadata) return fromMetadata;

    return null;
  }

  private parseRequirementsPayload(
    payload: string | undefined,
    requesterAgentId?: string,
  ): QueryRequest | null {
    if (!payload || payload.trim() === "") return null;

    const rawText = payload.trim();
    try {
      const raw = JSON.parse(rawText) as unknown;
      const result = QueryRequestSchema.safeParse(raw);
      if (result.success) return result.data;

      // Human-facing CROO surfaces may send looser JSON; map common keys.
      if (raw && typeof raw === "object") {
        const obj = raw as Record<string, unknown>;
        const queryCandidate =
          (typeof obj.query === "string" && obj.query) ||
          (typeof obj.prompt === "string" && obj.prompt) ||
          (typeof obj.task === "string" && obj.task) ||
          (typeof obj.message === "string" && obj.message);

        if (queryCandidate && queryCandidate.trim() !== "") {
          return {
            query: queryCandidate.trim(),
            max_price:
              typeof obj.max_price === "number"
                ? obj.max_price
                : this.config.runtime.servicePrice,
            caller_type: "human",
            ...(requesterAgentId ? { caller_id: requesterAgentId } : {}),
          };
        }
      }

      return null;
    } catch {
      // Treat non-JSON payloads as direct human queries.
      return {
        query: rawText,
        max_price: this.config.runtime.servicePrice,
        caller_type: "human",
        ...(requesterAgentId ? { caller_id: requesterAgentId } : {}),
      };
    }
  }
}
