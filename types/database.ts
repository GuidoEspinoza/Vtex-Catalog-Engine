export interface VtexAccount {
  id: string;
  company_name: string;
  account_name: string;
  environment: string;
  app_key: string;
  app_token: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export type VtexAccountInsert = Omit<VtexAccount, 'id' | 'created_at' | 'updated_at'>;
export type VtexAccountUpdate = Partial<VtexAccountInsert>;

export interface ExecutionLogEvent {
  timestamp: string;
  type: 'stdout' | 'stderr' | 'info' | 'warning' | 'error' | 'success' | 'progress' | 'summary' | 'complete' | 'failed';
  message: string;
  meta?: {
    current?: number;
    total?: number;
    percentage?: number;
    [key: string]: unknown;
  };
}
