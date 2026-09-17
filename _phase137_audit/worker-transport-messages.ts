export type WorkerTransportMessageType =
  | "AUTH_REQUEST"
  | "AUTH_RESPONSE"
  | "HEARTBEAT"
  | "HEARTBEAT_ACK"
  | "JOB_OFFER"
  | "JOB_ACCEPT"
  | "JOB_REJECT"
  | "JOB_CANCEL"
  | "JOB_CANCEL_ACK"
  | "JOB_RESULT"
  | "JOB_RESULT_ACK"
  | "SESSION_REVOKED"
  | "SESSION_EXPIRED"
  | "ERROR";

export interface WorkerTransportMessage<T = any> {
  messageId: string;
  type: WorkerTransportMessageType;
  sessionId?: string;
  workerId?: string;
  timestamp: number;
  protocolVersion: string;
  sequence?: number;
  correlationId?: string;
  payload?: T;
}
