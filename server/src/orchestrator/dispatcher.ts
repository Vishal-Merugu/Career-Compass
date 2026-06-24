export interface ExtensionDispatcher {
  sendSessionCheck(jobId: string): Promise<void>;
  sendFetchUrlBatch(
    jobId: string,
    batchNumber: number,
    targetCount: number,
  ): Promise<void>;
  sendScrapeProfile(jobId: string, urlId: string, url: string): Promise<void>;
  sendStopLimitReached(jobId: string): Promise<void>;
}
