import {
  IStorageAdapter,
  IUserConfig,
  IDailyStats,
  IProfileDetails,
} from '../shared/index.js';
import { prisma } from '../lib/prisma.js';

export class PrismaStorageAdapter implements IStorageAdapter {
  private userId: string;

  constructor(userId: string) {
    this.userId = userId;
  }

  /**
   * Generic key-value get (mapped to database models)
   */
  public async get(key: string): Promise<any> {
    if (key.startsWith('workflow_history_')) {
      const workflowType = key.replace('workflow_history_', '');
      const runs = await prisma.workflowRun.findMany({
        where: {
          userId: this.userId,
          workflowType,
          status: { in: ['completed', 'error', 'stoppedHalfway'] },
        },
        orderBy: { createdAt: 'desc' },
        take: 3,
      });

      return runs.map((run) => ({
        params: run.params,
        results: run.results || [],
        summary: {
          total: (run.progress as any)?.total || 0,
          matched: (run.results as any)?.length || 0,
          errors: (run.errors as any)?.length || 0,
          status: run.status,
        },
        startedAt: run.startedAt?.toISOString() || null,
        completedAt: run.completedAt?.toISOString() || null,
      }));
    }

    if (key.startsWith('workflow_')) {
      const workflowType = key.replace('workflow_', '');
      const latestRun = await prisma.workflowRun.findFirst({
        where: { userId: this.userId, workflowType },
        orderBy: { createdAt: 'desc' },
      });

      if (!latestRun) return null;

      return {
        status: latestRun.status,
        progress: latestRun.progress || { current: 0, total: 0, step: '' },
        results: latestRun.results || [],
        errors: latestRun.errors || [],
        startedAt: latestRun.startedAt?.toISOString() || null,
        completedAt: latestRun.completedAt?.toISOString() || null,
        params: latestRun.params || {},
        checkpoint: (latestRun.progress as any)?.checkpoint || {},
      };
    }

    return null;
  }

  /**
   * Generic key-value set (mapped to database models)
   */
  public async set(key: string, value: any): Promise<void> {
    if (key.startsWith('workflow_history_')) {
      // History is automatically compiled from past runs, no-op needed
      return;
    }

    if (key.startsWith('workflow_')) {
      const workflowType = key.replace('workflow_', '');
      const latestRun = await prisma.workflowRun.findFirst({
        where: { userId: this.userId, workflowType },
        orderBy: { createdAt: 'desc' },
      });

      const status = value.status;
      const progress = value.progress;
      const progressData = progress
        ? { ...progress, checkpoint: value.checkpoint }
        : null;
      const results = value.results;
      const errors = value.errors;
      const startedAt = value.startedAt ? new Date(value.startedAt) : null;
      const completedAt = value.completedAt
        ? new Date(value.completedAt)
        : null;
      const params = value.params;

      if (
        latestRun &&
        (latestRun.status === 'running' ||
          latestRun.status === 'paused' ||
          latestRun.status === 'idle')
      ) {
        await prisma.workflowRun.update({
          where: { id: latestRun.id },
          data: {
            status,
            progress: progressData ?? undefined,
            results: results ?? undefined,
            errors: errors ?? undefined,
            startedAt: startedAt ?? undefined,
            completedAt: completedAt ?? null,
            params: params ?? undefined,
          },
        });
      } else {
        await prisma.workflowRun.create({
          data: {
            userId: this.userId,
            workflowType,
            status,
            progress: progressData ?? {},
            results: results ?? [],
            errors: errors ?? [],
            startedAt: startedAt ?? new Date(),
            completedAt,
            params: params ?? {},
          },
        });
      }
    }
  }

  /**
   * Remove key (mapped to database models)
   */
  public async remove(key: string): Promise<void> {
    if (key.startsWith('workflow_')) {
      const workflowType = key.replace('workflow_', '');
      await prisma.workflowRun.deleteMany({
        where: { userId: this.userId, workflowType },
      });
    }
  }

  /**
   * Fetch UserConfig settings
   */
  public async getConfig(): Promise<IUserConfig> {
    const config = await prisma.userConfig.findUnique({
      where: { userId: this.userId },
    });

    if (!config) {
      throw new Error(
        `Configuration record not found for user ID: ${this.userId}`,
      );
    }

    return {
      keywords: config.keywords,
      locations: config.locations,
      dailyLimit: config.dailyLimit,
      llmProvider: config.llmProvider,
      llmApiKey: config.llmApiKey,
      llmUrl: config.llmUrl,
      llmModel: config.llmModel,
      userContext: config.userContext,
      targetGeoId: config.targetGeoId,
      emailFinderEnabled: config.emailFinderEnabled,
      isServerRun: config.isServerRun,
    };
  }

  /**
   * Log pipeline events to ActivityLog
   */
  public async addActivityLog(
    message: string,
    level: 'info' | 'warn' | 'error' = 'info',
  ): Promise<void> {
    await prisma.activityLog.create({
      data: {
        userId: this.userId,
        message,
        level,
      },
    });
  }

  /**
   * Log outreach attempts to OutreachLog
   */
  public async addOutreachLog(
    action: string,
    status: string,
    details?: any,
    profileId?: string,
    message?: string,
  ): Promise<void> {
    // Resolve profile record if profileId exists in DB
    let dbProfileId: string | undefined;
    if (profileId) {
      const profile = await prisma.profile.findUnique({
        where: { profileId },
        select: { id: true },
      });
      if (profile) {
        dbProfileId = profile.id;
      }
    }

    await prisma.outreachLog.create({
      data: {
        userId: this.userId,
        profileId: dbProfileId,
        action,
        status,
        message,
        details: details || {},
      },
    });
  }

  /**
   * Increment daily statistics
   */
  public async updateDailyStats(stats: Partial<IDailyStats>): Promise<void> {
    const today = new Date().toISOString().split('T')[0];
    const updateData: any = {};
    const createData: any = { userId: this.userId, date: today };

    for (const [key, value] of Object.entries(stats)) {
      if (typeof value === 'number') {
        updateData[key] = { increment: value };
        createData[key] = value;
      }
    }

    await prisma.dailyStats.upsert({
      where: {
        userId_date: {
          userId: this.userId,
          date: today,
        },
      },
      update: updateData,
      create: createData,
    });
  }

  /**
   * Retrieve daily statistics
   */
  public async getDailyStats(): Promise<IDailyStats> {
    const today = new Date().toISOString().split('T')[0];
    let stats = await prisma.dailyStats.findUnique({
      where: {
        userId_date: {
          userId: this.userId,
          date: today,
        },
      },
    });

    if (!stats) {
      stats = await prisma.dailyStats.create({
        data: {
          userId: this.userId,
          date: today,
        },
      });
    }

    return {
      connectionsSent: stats.connectionsSent,
      jobsFound: stats.jobsFound,
      companiesProcessed: stats.companiesProcessed,
      targetsFound: stats.targetsFound,
      emailsFound: stats.emailsFound,
    };
  }

  /**
   * Save or update a profile in the database
   */
  public async upsertProfile(profile: IProfileDetails): Promise<void> {
    // 1. Resolve or create the Company if companyName is provided
    let companyId: string | undefined;
    if (profile.companyName) {
      const companySlug = profile.companyName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-');
      // Look up company by name or slug
      const dbCompany = await prisma.company.upsert({
        where: { companyId: companySlug },
        update: { name: profile.companyName },
        create: {
          companyId: companySlug,
          name: profile.companyName,
          slug: companySlug,
        },
      });
      companyId = dbCompany.id;
    }

    // 2. Upsert the profile
    await prisma.profile.upsert({
      where: { profileId: profile.profileId },
      update: {
        memberId: profile.memberId ?? undefined,
        firstName: profile.firstName,
        lastName: profile.lastName,
        headline: profile.headline ?? undefined,
        about: profile.about ?? undefined,
        location: profile.location ?? undefined,
        linkedinUrl: profile.linkedinUrl,
        email: profile.email ?? undefined,
        emailSource: profile.emailSource ?? undefined,
        emailValidation: profile.emailValidation ?? undefined,
        companyId: companyId ?? null,
        rawProfileJson: profile.rawProfileJson ?? undefined,
      },
      create: {
        profileId: profile.profileId,
        memberId: profile.memberId ?? null,
        firstName: profile.firstName,
        lastName: profile.lastName,
        headline: profile.headline ?? null,
        about: profile.about ?? null,
        location: profile.location ?? null,
        linkedinUrl: profile.linkedinUrl,
        email: profile.email ?? null,
        emailSource: profile.emailSource ?? null,
        emailValidation: profile.emailValidation ?? null,
        companyId: companyId ?? null,
        rawProfileJson: profile.rawProfileJson ?? {},
      },
    });
  }
}
