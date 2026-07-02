/**
 * Re-exports of the CAP types this agent depends on, so the rest of the
 * codebase imports CROO shapes from one local module.
 */
export type {
  Event,
  Negotiation,
  Order,
  AcceptNegotiationResult,
  DeliverOrderResult,
  Delivery,
} from "@croo-network/sdk";
