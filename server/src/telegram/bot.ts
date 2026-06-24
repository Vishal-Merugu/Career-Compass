import TelegramBot from 'node-telegram-bot-api';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { ConnectionRegistry } from '../ws-gateway/connectionRegistry.js';
import { getIo } from '../ws-gateway/index.js';
import { ServerCommands } from '../ws-gateway/events.js';
import { dispatchNext } from '../orchestrator/dispatchNext.js';

class TelegramBotService {
  private bot: TelegramBot | null = null;

  /**
   * Initialize and trigger polling for the Telegram bot
   */
  public async initialize(): Promise<void> {
    if (!env.TELEGRAM_BOT_TOKEN) {
      logger.warn(
        'TELEGRAM_BOT_TOKEN is not configured. Telegram bot features will be offline.',
      );
      return;
    }

    logger.info('Initializing Telegram Bot polling service...');
    try {
      this.bot = new TelegramBot(env.TELEGRAM_BOT_TOKEN, { polling: true });

      this.bot.on('polling_error', (error: any) => {
        logger.error(
          { code: error.code, message: error.message },
          'Telegram Bot polling error',
        );
        if (error.message && error.message.includes('401')) {
          logger.warn(
            '⚠️ Telegram Bot Token appears to be invalid (401 Unauthorized). Stopping polling...',
          );
          this.bot?.stopPolling();
        }
      });

      this.registerListeners();
      logger.info(
        'Telegram Bot successfully initialized and listening for commands.',
      );
    } catch (err) {
      logger.error(err, 'Failed to launch Telegram Bot polling worker');
    }
  }

  /**
   * Terminate active polling
   */
  public stop(): void {
    if (this.bot) {
      this.bot.stopPolling();
      this.bot = null;
    }
  }

  /**
   * Helper method to send messages to a specific Telegram chat
   */
  public async sendMessage(
    chatId: string | number,
    text: string,
    options?: any,
  ): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram Bot is offline. Cannot route message.');
      return;
    }
    await this.bot.sendMessage(chatId, text, options);
  }

  /**
   * Register command routing handlers
   */
  private registerListeners(): void {
    if (!this.bot) return;

    // Fetch User by Telegram chatId
    const getUserByTelegram = async (chatId: number) => {
      const user = await prisma.user.findUnique({
        where: { telegramId: String(chatId) },
        include: { config: true },
      });
      return user;
    };

    // Welcome command /start
    this.bot.onText(/\/start/, async (msg) => {
      const chatId = msg.chat.id;
      const user = await getUserByTelegram(chatId);

      if (user) {
        await this.sendMessage(
          chatId,
          `👋 Welcome back to *CareerCompass*!\n\nYour account is linked (${user.email}).\nUse /help to see all available commands.`,
          { parse_mode: 'Markdown' },
        );
      } else {
        await this.sendMessage(
          chatId,
          `👋 Welcome to *CareerCompass*!\n\nTo control your campaigns from your phone, link your account by running:\n\n\`/link <your_api_key>\`\n\nRetrieve your API key from your browser extension configuration settings page.`,
          { parse_mode: 'Markdown' },
        );
      }
    });

    // Linking command /link <api_key>
    this.bot.onText(/\/link (.+)/, async (msg, match) => {
      const chatId = msg.chat.id;
      const apiKey = match?.[1]?.trim();

      if (!apiKey) {
        await this.sendMessage(
          chatId,
          '❌ Please specify your API key: `/link <api_key>`',
        );
        return;
      }

      try {
        const user = await prisma.user.findUnique({ where: { apiKey } });
        if (!user) {
          await this.sendMessage(
            chatId,
            '❌ Invalid API key. Verify key matches extension settings.',
          );
          return;
        }

        await prisma.user.update({
          where: { id: user.id },
          data: { telegramId: String(chatId) },
        });

        await this.sendMessage(
          chatId,
          `✅ Account successfully linked!\nLogged in as: *${user.email}*\n\nYou can now control active jobs and receive notifications here. Use /help to get started.`,
          { parse_mode: 'Markdown' },
        );
      } catch (err) {
        logger.error(err, 'Telegram link failed');
        await this.sendMessage(
          chatId,
          '❌ An error occurred during account linking.',
        );
      }
    });

    // Help command /help
    this.bot.onText(/\/help/, async (msg) => {
      const chatId = msg.chat.id;
      const user = await getUserByTelegram(chatId);
      if (!user) {
        await this.sendMessage(
          chatId,
          '🔒 Please link your account first using `/link <api_key>`',
        );
        return;
      }

      const helpText = `*CareerCompass Commands* 🧭

*Monitoring*
/status - Current status, LinkedIn session health, and daily stats
/stats - Today's processed metrics
/logs [limit] - Show recent logs (default last 10)
/session - Check LinkedIn session health

*Control*
/pause - Pause the active scraping job
/resume - Resume the paused scraping job
/stop - Cancel and stop the active scraping job

*Results*
/results - Overview of results from the last run
/results csv - Download results from the last run as CSV

*Settings*
/config - View current campaign settings`;

      await this.sendMessage(chatId, helpText, { parse_mode: 'Markdown' });
    });

    // Status query command /status
    this.bot.onText(/\/status/, async (msg) => {
      const chatId = msg.chat.id;
      const user = await getUserByTelegram(chatId);
      if (!user) return;

      try {
        const session = await prisma.linkedInSession.findUnique({
          where: { userId: user.id },
        });
        const stats = await prisma.dailyStats.findUnique({
          where: {
            userId_date: {
              userId: user.id,
              date: new Date().toISOString().split('T')[0],
            },
          },
        });

        const activeJob = await prisma.searchJob.findFirst({
          where: {
            userId: user.id,
            status: {
              in: [
                'initializing',
                'collecting_urls',
                'scraping',
                'paused_error',
              ],
            },
          },
        });

        let statusText = `*Status Overview*\n\n`;

        statusText += `*LinkedIn Session:* ${session?.isValid ? '🟢 Active' : '🔴 Expired/Invalid'}\n`;
        statusText += `*Server Run Mode:* ${user.config?.isServerRun ? '🟢 Enabled' : '🔴 Disabled'}\n\n`;

        if (activeJob) {
          const collectedCount = await prisma.profileUrl.count({
            where: { jobId: activeJob.id },
          });
          const scrapedCount = await prisma.profileUrl.count({
            where: { jobId: activeJob.id, status: 'scraped' },
          });
          statusText += `*Active Job:* \`${activeJob.id.slice(0, 8)}\`\n`;
          statusText += `*Status:* \`${activeJob.status}\`\n`;
          statusText += `*Progress:* ${scrapedCount} / ${collectedCount} profiles scraped (${activeJob.qualifiedCount} qualified)\n\n`;
        } else {
          statusText += `*Active Job:* None (Idle)\n\n`;
        }

        statusText += `*Daily Stats (Today):*\n`;
        statusText += `- Connections Sent: ${stats?.connectionsSent || 0} / ${user.config?.dailyLimit || 15}\n`;
        statusText += `- Profiles Qualified: ${stats?.targetsFound || 0}\n`;
        statusText += `- Emails Discovered: ${stats?.emailsFound || 0}\n`;

        await this.sendMessage(chatId, statusText, { parse_mode: 'Markdown' });
      } catch (err) {
        logger.error(err, 'Failed to fetch status');
        await this.sendMessage(chatId, '❌ Error fetching status details.');
      }
    });

    // Daily stats command /stats
    this.bot.onText(/\/stats/, async (msg) => {
      const chatId = msg.chat.id;
      const user = await getUserByTelegram(chatId);
      if (!user) return;

      const today = new Date().toISOString().split('T')[0];
      const stats = await prisma.dailyStats.findUnique({
        where: { userId_date: { userId: user.id, date: today } },
      });

      const text =
        `*Today's Activity Metrics (${today})* 📊\n\n` +
        `- Connections Sent: ${stats?.connectionsSent || 0} / ${user.config?.dailyLimit || 15}\n` +
        `- Targets Qualified: ${stats?.targetsFound || 0}\n` +
        `- Emails Found: ${stats?.emailsFound || 0}\n` +
        `- Jobs Discovered: ${stats?.jobsFound || 0}\n` +
        `- Companies Evaluated: ${stats?.companiesProcessed || 0}`;

      await this.sendMessage(chatId, text, { parse_mode: 'Markdown' });
    });

    // Recent activity log query /logs
    this.bot.onText(/\/logs\s*(\d+)?/, async (msg, match) => {
      const chatId = msg.chat.id;
      const user = await getUserByTelegram(chatId);
      if (!user) return;

      const limit = match?.[1] ? parseInt(match[1], 10) : 10;
      const logs = await prisma.activityLog.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: 'desc' },
        take: limit,
      });

      if (logs.length === 0) {
        await this.sendMessage(chatId, 'No activity logs found.');
        return;
      }

      const logText = logs
        .reverse()
        .map(
          (log) =>
            `[${new Date(log.createdAt).toLocaleTimeString()}] ${log.message}`,
        )
        .join('\n');

      await this.sendMessage(
        chatId,
        `*Recent Activity Logs* 📋\n\n\`\`\`\n${logText}\n\`\`\``,
        {
          parse_mode: 'Markdown',
        },
      );
    });

    // Session validation query /session
    this.bot.onText(/\/session/, async (msg) => {
      const chatId = msg.chat.id;
      const user = await getUserByTelegram(chatId);
      if (!user) return;

      const session = await prisma.linkedInSession.findUnique({
        where: { userId: user.id },
      });
      if (!session) {
        await this.sendMessage(
          chatId,
          '❌ No LinkedIn session cookies saved. Please log in using the Chrome extension.',
        );
        return;
      }

      await this.sendMessage(
        chatId,
        `*Session Health Check* 🔑\n\n` +
          `- Status: ${session.isValid ? '🟢 Valid / Connected' : '🔴 Expired / Action Required'}\n` +
          `- Last Checked: ${new Date(session.lastChecked).toLocaleString()}`,
        { parse_mode: 'Markdown' },
      );
    });

    // Workflow run command (deprecated in new architecture)
    this.bot.onText(/\/run.*/, async (msg) => {
      const chatId = msg.chat.id;
      await this.sendMessage(
        chatId,
        '❌ Starting jobs directly via Telegram is deprecated. Please launch campaigns via your Chrome Extension Popup panel.',
      );
    });

    // Workflow controls: /pause
    this.bot.onText(/\/pause/, async (msg) => {
      const chatId = msg.chat.id;
      const user = await getUserByTelegram(chatId);
      if (!user) return;

      try {
        const activeJob = await prisma.searchJob.findFirst({
          where: {
            userId: user.id,
            status: { in: ['initializing', 'collecting_urls', 'scraping'] },
          },
        });

        if (!activeJob) {
          await this.sendMessage(chatId, '⚠️ No active job running to pause.');
          return;
        }

        await prisma.searchJob.update({
          where: { id: activeJob.id },
          data: { status: 'paused_error' },
        });

        const socketId = ConnectionRegistry.getInstance().getSocketId(
          activeJob.id,
        );
        if (socketId) {
          const io = getIo();
          io.to(socketId).emit(ServerCommands.PAUSE);
        }

        await this.sendMessage(chatId, '⏸ Job paused successfully.');
      } catch (err: any) {
        await this.sendMessage(chatId, `❌ Error: ${err.message}`);
      }
    });

    // Workflow controls: /resume
    this.bot.onText(/\/resume/, async (msg) => {
      const chatId = msg.chat.id;
      const user = await getUserByTelegram(chatId);
      if (!user) return;

      try {
        const activeJob = await prisma.searchJob.findFirst({
          where: {
            userId: user.id,
            status: 'paused_error',
          },
        });

        if (!activeJob) {
          await this.sendMessage(chatId, '⚠️ No paused job to resume.');
          return;
        }

        // Reset any active scraping items back to queued so they can be re-run
        await prisma.profileUrl.updateMany({
          where: {
            jobId: activeJob.id,
            status: { in: ['dispatched', 'scraping'] },
          },
          data: {
            status: 'queued',
            dispatchedAt: null,
          },
        });

        await prisma.searchJob.update({
          where: { id: activeJob.id },
          data: { status: 'scraping' },
        });

        const socketId = ConnectionRegistry.getInstance().getSocketId(
          activeJob.id,
        );
        if (socketId) {
          const io = getIo();
          io.to(socketId).emit(ServerCommands.RESUME);
        }

        // Trigger next dispatch
        await dispatchNext(activeJob.id);

        await this.sendMessage(chatId, '▶ Job resumed successfully.');
      } catch (err: any) {
        await this.sendMessage(chatId, `❌ Error: ${err.message}`);
      }
    });

    // Workflow controls: /stop
    this.bot.onText(/\/stop/, async (msg) => {
      const chatId = msg.chat.id;
      const user = await getUserByTelegram(chatId);
      if (!user) return;

      try {
        const activeJob = await prisma.searchJob.findFirst({
          where: {
            userId: user.id,
            status: {
              in: [
                'initializing',
                'collecting_urls',
                'scraping',
                'paused_error',
              ],
            },
          },
        });

        if (!activeJob) {
          await this.sendMessage(chatId, '⚠️ No active or paused job to stop.');
          return;
        }

        // Skip remaining queued URLs
        await prisma.profileUrl.updateMany({
          where: { jobId: activeJob.id, status: 'queued' },
          data: { status: 'skipped' },
        });

        await prisma.searchJob.update({
          where: { id: activeJob.id },
          data: { status: 'completed' },
        });

        const socketId = ConnectionRegistry.getInstance().getSocketId(
          activeJob.id,
        );
        if (socketId) {
          const io = getIo();
          io.to(socketId).emit(ServerCommands.STOP_LIMIT_REACHED);
        }

        await this.sendMessage(chatId, '⏹ Job stopped successfully.');
      } catch (err: any) {
        await this.sendMessage(chatId, `❌ Error: ${err.message}`);
      }
    });

    // Results query command /results and /results csv
    this.bot.onText(/\/results(?:\s+(\w+))?/, async (msg, match) => {
      const chatId = msg.chat.id;
      const user = await getUserByTelegram(chatId);
      if (!user) return;

      const format = match?.[1]?.toLowerCase();

      try {
        const latestJob = await prisma.searchJob.findFirst({
          where: { userId: user.id },
          orderBy: { createdAt: 'desc' },
        });

        if (!latestJob) {
          await this.sendMessage(chatId, 'No search job history found.');
          return;
        }

        const decisions = await prisma.profileDecision.findMany({
          where: {
            profile: {
              profileUrl: {
                jobId: latestJob.id,
              },
            },
          },
          include: {
            profile: true,
          },
        });

        if (format === 'csv') {
          const results = decisions.map((d) => ({
            name: d.profile.name,
            headline: d.profile.headline || '',
            company: d.profile.company || '',
            location: d.profile.location || '',
            isQualified: d.isQualified ? 'Yes' : 'No',
            email: d.email || '',
            qualificationReason: d.qualificationReason || '',
            decidedAt: d.decidedAt.toISOString(),
          }));

          const headers = [
            'Name',
            'Headline',
            'Company',
            'Location',
            'Qualified',
            'Email',
            'Reason',
            'Decided At',
          ];
          const csvRows = [headers.join(',')];
          for (const r of results) {
            const values = [
              `"${r.name.replace(/"/g, '""')}"`,
              `"${r.headline.replace(/"/g, '""')}"`,
              `"${r.company.replace(/"/g, '""')}"`,
              `"${r.location.replace(/"/g, '""')}"`,
              r.isQualified,
              r.email,
              `"${r.qualificationReason.replace(/"/g, '""')}"`,
              r.decidedAt,
            ];
            csvRows.push(values.join(','));
          }
          const csvString = csvRows.join('\n');
          const buffer = Buffer.from(csvString, 'utf-8');

          await this.bot!.sendDocument(
            chatId,
            buffer,
            {},
            { filename: `results_${latestJob.id.slice(0, 8)}.csv` },
          );
        } else {
          let text =
            `*Latest Job Results Summary* 📊\n\n` +
            `- Job ID: \`${latestJob.id.slice(0, 8)}\`\n` +
            `- Status: \`${latestJob.status}\`\n` +
            `- Limit Requested: ${latestJob.limitRequested}\n` +
            `- Qualified Found: ${latestJob.qualifiedCount}\n\n`;

          const qualifiedDecisions = decisions.filter((d) => d.isQualified);
          if (qualifiedDecisions.length > 0) {
            text += `*Recent qualified targets:*\n`;
            qualifiedDecisions.slice(0, 5).forEach((d, idx) => {
              text += `${idx + 1}. *${d.profile.name}* - ${d.profile.headline || ''} ${d.email ? `(${d.email})` : ''}\n`;
            });
            if (qualifiedDecisions.length > 5) {
              text += `\n_...and ${qualifiedDecisions.length - 5} more. Send \`/results csv\` to download all as a CSV file._`;
            }
          }

          await this.sendMessage(chatId, text, { parse_mode: 'Markdown' });
        }
      } catch (err: any) {
        logger.error(err, 'Failed to fetch results');
        await this.sendMessage(
          chatId,
          `❌ Error fetching results: ${err.message}`,
        );
      }
    });

    // Configurations lookup command /config
    this.bot.onText(/\/config/, async (msg) => {
      const chatId = msg.chat.id;
      const user = await getUserByTelegram(chatId);
      if (!user) return;

      const configText =
        `*CareerCompass Configurations* ⚙️\n\n` +
        `- Keywords: \`${user.config?.keywords || 'None'}\`\n` +
        `- Locations: \`${user.config?.locations || 'None'}\`\n` +
        `- Daily Connection Limit: \`${user.config?.dailyLimit || 15}\`\n` +
        `- Email Finder Enabled: \`${user.config?.emailFinderEnabled ? 'Yes' : 'No'}\`\n` +
        `- LLM Provider: \`${user.config?.llmProvider || 'ollama'}\`\n` +
        `- LLM Model: \`${user.config?.llmModel || 'qwen2.5:1.5b'}\`\n` +
        `- Server Mode (isServerRun): \`${user.config?.isServerRun ? 'Active' : 'Inactive'}\``;

      await this.sendMessage(chatId, configText, { parse_mode: 'Markdown' });
    });
  }
}

export const telegramBotService = new TelegramBotService();
export default telegramBotService;
export type { TelegramBotService };
