import { ConnectionOptions, DefaultJobOptions } from 'bullmq';

export interface QueueConfig {
  connection: ConnectionOptions;
  defaultJobOptions: DefaultJobOptions;
  chunkingQueue: {
    name: string;
    options: DefaultJobOptions;
  };
  processingQueue: {
    name: string;
    options: DefaultJobOptions;
  };
}
