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
      const parsed = this.parseRequirements(negotiation.requirements);

      if (!parsed) {
        await this.client.rejectNegotiation(
          negotiationId,
          "Invalid or missing requirements payload",
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

      const result = await this.client.acceptNegotiation(negotiationId);
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
        const parsed = this.parseRequirements(negotiation.requirements);
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

  private parseRequirements(requirements: string | undefined): QueryRequest | null {
    if (!requirements) return null;
    try {
      const raw = JSON.parse(requirements) as unknown;
      const result = QueryRequestSchema.safeParse(raw);
      return result.success ? result.data : null;
    } catch {
      return null;
    }
  }
}
