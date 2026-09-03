import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import type { JobEvaluationResult } from './jobFinder.service.js';

export interface SavedEasyApplyJob {
  id: string;
  userId?: string | null;
  jobId: string;
  title: string;
  company: string;
  location: string;
  url: string;
  postedDate?: string | null;
  passed: boolean;
  fitScore: number;
  languageAssessment: string;
  reason: string;
  jdSnippet?: string | null;
  searchPrompt?: string | null;
  createdAt: string;
  updatedAt: string;
}

const DATA_DIR = resolve(process.cwd(), 'data');
const DB_FILE = resolve(DATA_DIR, 'easy_apply_jobs_db.json');

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!existsSync(DB_FILE)) {
    writeFileSync(DB_FILE, JSON.stringify([]), 'utf8');
  }
}

function readLocalDb(): SavedEasyApplyJob[] {
  try {
    ensureDataDir();
    const data = readFileSync(DB_FILE, 'utf8');
    return JSON.parse(data);
  } catch {
    return [];
  }
}

function writeLocalDb(jobs: SavedEasyApplyJob[]): void {
  try {
    ensureDataDir();
    writeFileSync(DB_FILE, JSON.stringify(jobs, null, 2), 'utf8');
  } catch (err: any) {
    logger.error(`[EasyApplyStorage] Failed to write local DB: ${err.message}`);
  }
}

/**
 * Persists a qualified job into DB (Postgres via Prisma with local persistent fallback).
 */
export async function saveQualifiedJobToDb(
  job: JobEvaluationResult,
  searchPrompt?: string,
  userId?: string,
): Promise<SavedEasyApplyJob> {
  const now = new Date().toISOString();
  const jobRecord: SavedEasyApplyJob = {
    id: 'eaj_' + job.jobId,
    userId: userId || null,
    jobId: job.jobId,
    title: job.title,
    company: job.company,
    location: job.location,
    url: job.url,
    postedDate: job.postedDate,
    passed: job.passed,
    fitScore: job.fitScore,
    languageAssessment: job.languageAssessment,
    reason: job.reason,
    jdSnippet: job.jdSnippet,
    searchPrompt: searchPrompt || null,
    createdAt: now,
    updatedAt: now,
  };

  // 1. Try Prisma (Postgres)
  try {
    const saved = await (prisma as any).easyApplyJob.upsert({
      where: { jobId: job.jobId },
      update: {
        title: job.title,
        company: job.company,
        location: job.location,
        url: job.url,
        passed: job.passed,
        fitScore: job.fitScore,
        languageAssessment: job.languageAssessment,
        reason: job.reason,
        jdSnippet: job.jdSnippet,
        searchPrompt: searchPrompt || null,
        updatedAt: new Date(),
      },
      create: {
        id: jobRecord.id,
        userId: userId || null,
        jobId: job.jobId,
        title: job.title,
        company: job.company,
        location: job.location,
        url: job.url,
        postedDate: job.postedDate,
        passed: job.passed,
        fitScore: job.fitScore,
        languageAssessment: job.languageAssessment,
        reason: job.reason,
        jdSnippet: job.jdSnippet,
        searchPrompt: searchPrompt || null,
      },
    });
    logger.info(
      `[EasyApplyStorage] Persisted job ${job.jobId} to PostgreSQL database`,
    );
    return {
      ...jobRecord,
      id: saved.id,
      createdAt: saved.createdAt.toISOString(),
      updatedAt: saved.updatedAt.toISOString(),
    };
  } catch {
    // Postgres unreachable in local dev or offline: fallback to local JSON DB
    const list = readLocalDb();
    const existingIdx = list.findIndex((j) => j.jobId === job.jobId);
    if (existingIdx !== -1) {
      list[existingIdx] = {
        ...list[existingIdx],
        ...jobRecord,
        updatedAt: now,
      };
    } else {
      list.unshift(jobRecord);
    }
    writeLocalDb(list);
    logger.info(
      `[EasyApplyStorage] Persisted job ${job.jobId} to database storage`,
    );
    return jobRecord;
  }
}

/**
 * Retrieves saved filtered jobs from DB.
 */
export async function getSavedJobsFromDb(
  userId?: string,
): Promise<SavedEasyApplyJob[]> {
  try {
    const rows = await (prisma as any).easyApplyJob.findMany({
      where: userId ? { userId } : undefined,
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r: any) => ({
      ...r,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }));
  } catch {
    const list = readLocalDb();
    if (userId) {
      return list.filter((j) => !j.userId || j.userId === userId);
    }
    return list;
  }
}

/**
 * Deletes a saved job from DB.
 */
export async function deleteSavedJobFromDb(jobId: string): Promise<boolean> {
  try {
    await (prisma as any).easyApplyJob.delete({ where: { jobId } });
  } catch {
    // ignore
  }

  const list = readLocalDb();
  const filtered = list.filter((j) => j.jobId !== jobId);
  writeLocalDb(filtered);
  return true;
}
