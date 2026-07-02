import { z } from "zod";

export const CallerType = {
  Human: "human",
  Agent: "agent",
} as const;
export type CallerType = (typeof CallerType)[keyof typeof CallerType];

/**
 * Query payload carried inside a CAP negotiation/order `requirements` string,
 * or posted to the local dev endpoint. Mirrors the API request schema in the
 * build spec.
 */
export const QueryRequestSchema = z.object({
  query: z.string().min(1).max(2000),
  max_price: z.number().min(0),
  caller_type: z.enum(["human", "agent"]),
  caller_id: z.string().optional(),
  order_id: z.string().optional(),
  negotiation_id: z.string().optional(),
  context: z
    .object({
      source: z.string().optional(),
      priority: z.enum(["low", "normal", "high"]).default("normal").optional(),
      locale: z.string().optional(),
      deadline: z.string().datetime().optional(),
    })
    .strict()
    .optional(),
}).superRefine((val, ctx) => {
  if (val.caller_type === "agent" && !val.caller_id) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["caller_id"],
      message: "caller_id is required for agent (A2A) callers",
    });
  }
});

export type QueryRequest = z.infer<typeof QueryRequestSchema>;

export type TaskStatus =
  | "CREATED"
  | "DISPATCHED"
  | "AWAITING_VALIDATOR"
  | "VALIDATED"
  | "DELIVERED"
  | "SETTLED"
  | "TIMEOUT"
  | "FAILED";

export interface ValidatorResponse {
  task_id: string;
  answer: string;
  confidence: number;
  validator_id: string;
  validator_username?: string | null;
  raw_message: string;
  received_at: string;
  message_id: number;
}

export interface Task {
  task_id: string;
  order_id?: string;
  negotiation_id?: string;
  query: string;
  status: TaskStatus;
  caller_type: CallerType;
  caller_id?: string | null;
  max_price: number;
  created_at: string;
  updated_at: string;
  dispatched_at?: string | null;
  validated_at?: string | null;
  validator_response?: ValidatorResponse | null;
  latency_ms?: number | null;
  error?: { code: ErrorCode; message: string } | null;
}

export type PaymentStatus =
  | "locked"
  | "settled"
  | "refunded"
  | "disputed"
  | "pending";

export interface PaymentMetadata {
  amount: string;
  currency: string;
  status: PaymentStatus;
  reference: string;
  order_id?: string;
  settlement_tx?: string;
}

export interface ValidatorAttribution {
  id: string;
  confidence: number;
  platform: "telegram";
}

export interface ResponseData {
  answer: string;
  confidence: number;
  validators: ValidatorAttribution[];
  metadata: {
    task_id: string;
    order_id?: string;
    latency_ms: number;
    timestamp: string;
    caller_type?: CallerType;
    caller_id?: string;
  };
  payment: PaymentMetadata;
}

export type ErrorCode =
  | "VALIDATION_ERROR"
  | "TIMEOUT"
  | "NO_VALIDATOR_RESPONSE"
  | "INVALID_VALIDATOR_FORMAT"
  | "ORDER_REJECTED"
  | "DELIVERY_FAILED"
  | "CAP_ERROR"
  | "INTERNAL_ERROR";

export interface AgentErrorResponse {
  status: "error";
  error: {
    code: ErrorCode;
    message: string;
    task_id?: string;
    order_id?: string;
  };
}

export interface AgentSuccessResponse {
  status: "success";
  data: ResponseData;
}

export type AgentResponse = AgentSuccessResponse | AgentErrorResponse;
