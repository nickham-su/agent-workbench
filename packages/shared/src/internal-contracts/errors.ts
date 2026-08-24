export type InternalErrorPayload = {
  code: string;
  message: string;
  status?: number;
  retryable?: boolean;
  details?: unknown;
  requestId?: string;
};

export const InternalErrorCode = {
  Unauthorized: "INTERNAL_UNAUTHORIZED",
  InvalidRequest: "INTERNAL_INVALID_REQUEST",
  HandlerError: "INTERNAL_HANDLER_ERROR"
} as const;

export type InternalErrorCode = (typeof InternalErrorCode)[keyof typeof InternalErrorCode];
