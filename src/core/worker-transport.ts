export interface WorkerTransport {
  connect(): Promise<void>;
  authenticate(workerId: string, credential: string): Promise<boolean>;
  heartbeat(workerId: string, currentJobId?: string): Promise<void>;
  receiveJob(workerId: string): Promise<any | null>;
  reportResult(workerId: string, result: any): Promise<void>;
  cancelJob(workerId: string, jobId: string): Promise<void>;
  disconnect(): Promise<void>;
}
