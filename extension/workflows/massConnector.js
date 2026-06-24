// ─── Mass Connector Workflow ───────────────────────────────────────
// Connects with a list of LinkedIn profiles (from URLs or IDs) and sends
// AI-generated personalized connection requests.
// Uses the BaseWorkflow circuit breaker for fault tolerance.

class MassConnectorWorkflow extends BaseWorkflow {
  constructor() {
    super('massConnector', 'Mass Connector');
  }

  getCheckpoint() {
    return {
      processedIndex: this._processedIndex || 0,
      dailyCount: this._dailyCount || 0,
    };
  }

  async execute(params) {
    const { urls = [], prompt = '' } = params;

    const checkpoint = await this.loadState().then((s) => s?.checkpoint || {});
    this._processedIndex = checkpoint.processedIndex || 0;
    this._dailyCount = checkpoint.dailyCount || 0;

    await addActivityEntry(
      `🚀 Started Mass Connector for ${urls.length} profiles`,
    );

    const config = await getConfig();
    const dailyLimit = config.dailyLimit || 15;

    // Extract profile IDs from URLs
    const profileIds = urls
      .map((url) => {
        try {
          if (!url.includes('linkedin.com/in/')) return url.trim();
          const parsed = new URL(url);
          const parts = parsed.pathname.split('/').filter(Boolean);
          if (parts[0] === 'in' && parts[1]) return parts[1];
        } catch {
          // not a URL — use as-is
        }
        return url.trim();
      })
      .filter(Boolean);

    const total = profileIds.length;

    for (let i = this._processedIndex; i < total; i++) {
      if (!(await this.shouldContinue())) break;

      const profileId = profileIds[i];
      await this.updateProgress(i, total, `Processing: ${profileId}`);

      // Check daily limit
      if (this._dailyCount >= dailyLimit) {
        await addActivityEntry(
          `⚠️ Daily connection limit reached (${dailyLimit})`,
        );
        break;
      }

      try {
        // 1. Fetch Profile
        const profileRes = await fetchFullProfile(profileId);
        this.onApiSuccess();
        const profile = parseFullProfile(profileRes);

        if (!profile.memberId) {
          this.addResult({
            profileId,
            name: profileId,
            status: 'Failed',
            error: 'Profile not found',
          });
          continue;
        }

        const companyName = profile.experiences[0]?.companyName || 'Unknown';

        // Find Email if enabled
        let emailData = { email: '', source: '', validation: '' };
        if (config.emailFinderEnabled) {
          await this.updateProgress(
            i,
            total,
            `Finding email for: ${profile.firstName}...`,
          );
          try {
            const emailResult = await findEmail(
              profile.publicIdentifier || profileId,
              {
                firstName: profile.firstName,
                lastName: profile.lastName,
                companyName: companyName,
              },
            );
            if (emailResult.ok && emailResult.email) {
              emailData = {
                email: emailResult.email,
                source: emailResult.source || 'unknown',
                validation: emailResult.validation || 'unknown',
              };
            }
          } catch (emailErr) {
            console.error(
              `[MassConnector] Email finder failed for ${profile.firstName}:`,
              emailErr,
            );
          }
        }

        // 2. Check Relationship
        const relRes = await checkRelationship(profile.memberId);
        this.onApiSuccess();
        const rel = parseRelationship(relRes);

        if (rel.isConnected) {
          this.addResult({
            profileId,
            name: `${profile.firstName} ${profile.lastName}`,
            company: companyName,
            status: 'Skipped',
            error: 'Already connected',
            email: emailData.email,
            emailSource: emailData.source,
            emailValidation: emailData.validation,
          });
          continue;
        }
        if (rel.isPending) {
          this.addResult({
            profileId,
            name: `${profile.firstName} ${profile.lastName}`,
            company: companyName,
            status: 'Skipped',
            error: 'Invite pending',
            email: emailData.email,
            emailSource: emailData.source,
            emailValidation: emailData.validation,
          });
          continue;
        }

        // 3. Generate Message
        await this.updateProgress(
          i,
          total,
          `Generating note for: ${profile.firstName}...`,
        );
        const llmRes = await generateConnectionMessage(
          profile,
          companyName,
          prompt,
          config,
        );

        if (!llmRes.ok) {
          this.addResult({
            profileId,
            name: `${profile.firstName} ${profile.lastName}`,
            company: companyName,
            status: 'Failed',
            error: `AI Failed: ${llmRes.error || 'unknown'}`,
            email: emailData.email,
            emailSource: emailData.source,
            emailValidation: emailData.validation,
          });
          continue;
        }

        const message = llmRes.message;

        // 4. Send Connection
        await this.updateProgress(
          i,
          total,
          `Connecting: ${profile.firstName}...`,
        );
        await connectionDelay();
        const connectRes = await sendConnectionRequest(
          profile.memberId,
          message,
        );
        this.onApiSuccess();

        if (connectRes) {
          this.addResult({
            profileId,
            name: `${profile.firstName} ${profile.lastName}`,
            company: companyName,
            status: 'Sent',
            message,
            email: emailData.email,
            emailSource: emailData.source,
            emailValidation: emailData.validation,
          });
          this._dailyCount++;
          await incrementDailyStat('connectionsSent');
          await addActivityEntry(
            `✉️ Request sent & email found for ${profile.firstName} ${profile.lastName}`,
          );
        } else {
          this.addResult({
            profileId,
            name: `${profile.firstName} ${profile.lastName}`,
            company: companyName,
            status: 'Failed',
            error: 'API Reject',
            email: emailData.email,
            emailSource: emailData.source,
            emailValidation: emailData.validation,
          });
        }
      } catch (err) {
        const isResourceError =
          err.message.includes('→ 403') || err.message.includes('→ 404');
        if (isResourceError) {
          console.warn(
            `[MassConnector] Profile ${profileId} is inaccessible or private (403/404). Skipping.`,
          );
          this.addResult({
            profileId,
            name: profileId,
            status: 'Skipped',
            error: 'Profile inaccessible/private (403/404)',
          });
          await addActivityEntry(
            `⏭️ Skipping ${profileId} (profile inaccessible/private)`,
          );
          this.onApiSuccess(); // The network/session is healthy, this is just a bad/malformed profile
        } else {
          this.addResult({
            profileId,
            name: profileId,
            status: 'Error',
            error: err.message,
          });
          await this.onApiFailure(err, `Profile ${profileId}`);
          // If onApiFailure didn't throw, we continue to next profile
        }
      }

      this._processedIndex = i + 1;
      await this.saveState();
    }

    await this.updateProgress(this._processedIndex, total, 'Complete');
  }
}

// ─── Register ────────────────────────────────────────────────────

if (typeof globalThis !== 'undefined') {
  Object.assign(globalThis, { MassConnectorWorkflow });
  WorkflowRegistry.register(new MassConnectorWorkflow());
}
