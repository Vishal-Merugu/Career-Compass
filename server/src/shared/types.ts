export interface ISession {
  csrfToken: string;
  liAtCookie: string;
}

export interface IVoyagerClient {
  isLinkedInLoggedIn(): Promise<boolean>;
  voyagerGet(endpoint: string, accept?: string): Promise<any>;
  voyagerPost(endpoint: string, body: any, accept?: string): Promise<any>;
  voyagerDelete(endpoint: string): Promise<any>;
  searchJobs(
    keywords: string,
    location: string,
    start?: number,
    count?: number,
  ): Promise<any>;
  resolveCompany(universalName: string): Promise<any>;
  getCompanyById(companyId: string): Promise<any>;
  searchPeople(
    companyId: string,
    geoId?: string,
    start?: number,
    count?: number,
  ): Promise<any>;
  fetchProfile(memberIdentity: string): Promise<any>;
  fetchFullProfile(memberIdentity: string): Promise<any>;
  checkRelationship(profileId: string): Promise<any>;
  sendConnectionRequest(memberId: string, message?: string): Promise<any>;
  withdrawInvitation(invitationId: string): Promise<any>;
}

export interface IUserConfig {
  keywords: string;
  locations: string;
  dailyLimit: number;
  llmProvider: string;
  llmApiKey?: string | null;
  llmUrl: string;
  llmModel: string;
  userContext?: string | null;
  targetGeoId: string;
  emailFinderEnabled: boolean;
  isServerRun: boolean;
}

export interface IDailyStats {
  connectionsSent: number;
  jobsFound: number;
  companiesProcessed: number;
  targetsFound: number;
  emailsFound: number;
}

export interface IWorkflowRunState {
  status:
    | 'idle'
    | 'running'
    | 'paused'
    | 'completed'
    | 'stoppedHalfway'
    | 'error';
  progress: {
    current: number;
    total: number;
    step: string;
    [key: string]: any;
  };
  results: any[];
  errors: string[];
  startedAt: string | null;
  completedAt: string | null;
  params: any;
  checkpoint?: any;
}

export interface IProfileDetails {
  profileId: string;
  memberId?: string | null;
  firstName: string;
  lastName: string;
  headline?: string | null;
  about?: string | null;
  location?: string | null;
  linkedinUrl: string;
  email?: string | null;
  emailSource?: string | null;
  emailValidation?: string | null;
  companyName?: string | null;
  rawProfileJson?: any;
}

export interface IStorageAdapter {
  get(key: string): Promise<any>;
  set(key: string, value: any): Promise<void>;
  remove(key: string): Promise<void>;
  getConfig(): Promise<IUserConfig>;
  addActivityLog(
    message: string,
    level?: 'info' | 'warn' | 'error',
  ): Promise<void>;
  addOutreachLog(
    action: string,
    status: string,
    details?: any,
    profileId?: string,
    message?: string,
  ): Promise<void>;
  updateDailyStats(stats: Partial<IDailyStats>): Promise<void>;
  getDailyStats(): Promise<IDailyStats>;
  upsertProfile(profile: IProfileDetails): Promise<void>;
}

export interface INotifier {
  notify(title: string, message: string): Promise<void> | void;
}

export interface IEmailFinderResult {
  ok: boolean;
  email?: string;
  source?: string;
  validation?: string;
  error?: string;
}

export interface IEmailFinder {
  findEmail(
    linkedinUrl: string,
    contactInfo: { firstName: string; lastName: string; companyName: string },
  ): Promise<IEmailFinderResult>;
}
