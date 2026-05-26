// ─── People Finder Workflow ────────────────────────────────────────
// Finds and AI-qualifies people from a specific company based on a prompt.
// Uses the BaseWorkflow circuit breaker for fault tolerance.

class PeopleFinderWorkflow extends BaseWorkflow {
  constructor() {
    super('peopleFinder', 'People Finder');
  }

  getCheckpoint() {
    return {
      collected: this.results.length,
      pageStart: this._pageStart || 0,
      processedIds: this._processedIds ? Array.from(this._processedIds) : [],
    };
  }

  async execute(params) {
    const { companyUrl, searchPrompt, maxResults = 100 } = params;

    // Resume state or initialize
    const checkpoint = await this.loadState().then((s) => s?.checkpoint || {});
    this._pageStart = checkpoint.pageStart || 0;
    this._processedIds = new Set(checkpoint.processedIds || []);

    await addActivityEntry(`🔍 Started People Finder for ${companyUrl}`);

    // 1. Resolve Company URL → Company ID
    await this.updateProgress(0, maxResults, 'Resolving company...');
    const companySlug = parseCompanyUrl(companyUrl);
    if (!companySlug) {
      throw new Error('Invalid LinkedIn Company URL');
    }

    const companyRes = await resolveCompany(companySlug);
    const elements =
      companyRes.data?.['*elements'] || companyRes?.['*elements'] || [];
    const firstElement = elements[0];
    const companyId =
      typeof firstElement === 'string'
        ? firstElement.split(':').pop()
        : firstElement?.targetUrn?.split(':').pop();

    if (!companyId) {
      throw new Error(`Could not find company ID for: ${companySlug}`);
    }

    let companyName = companySlug;
    const included = companyRes.included || [];
    const companyObj = included.find(
      (item) =>
        item.$type?.includes('Company') ||
        item.$type?.includes('Organization') ||
        item.name,
    );
    if (companyObj && companyObj.name) {
      companyName = companyObj.name;
    } else if (typeof firstElement !== 'string' && firstElement?.text?.text) {
      companyName = firstElement.text.text;
    }
    await addActivityEntry(
      `🏢 Resolved company: ${companyName} (ID: ${companyId})`,
    );

    // 2. Fetch config for LLM evaluation and geoId
    const config = await getConfig();
    const geoId = config.targetGeoId || '101282230';

    // 3. Paginated Search
    let hasMore = true;
    let noNewResultsCount = 0;

    while (
      this.results.length < maxResults &&
      hasMore &&
      (await this.shouldContinue())
    ) {
      await this.updateProgress(
        this.results.length,
        maxResults,
        `Searching people (Page ${Math.floor(this._pageStart / 12) + 1})...`,
      );

      // Fetch page of people
      let people, meta;
      try {
        const searchRes = await searchPeople(
          companyId,
          geoId,
          this._pageStart,
          12,
        );
        this.onApiSuccess();

        people = parsePeopleSearchResults(searchRes);
        meta = parsePaginationMetadata(searchRes);
      } catch (err) {
        await this.onApiFailure(err, `People search page ${this._pageStart}`);
        continue; // onApiFailure will throw if breaker trips
      }

      if (people.length === 0) {
        hasMore = false;
        break;
      }

      let newProfilesFound = false;

      // 4. Evaluate each person
      for (const person of people) {
        if (!(await this.shouldContinue())) break;
        if (this.results.length >= maxResults) break;
        if (this._processedIds.has(person.profileId)) continue;

        this._processedIds.add(person.profileId);
        newProfilesFound = true;

        await this.updateProgress(
          this.results.length,
          maxResults,
          `Evaluating: ${person.name}...`,
        );

        try {
          const fullProfileRes = await fetchFullProfile(person.profileId);
          this.onApiSuccess();
          const fullProfile = parseFullProfile(fullProfileRes);

          // Evaluate with LLM
          const evalRes = await evaluateProfile(
            fullProfile,
            searchPrompt,
            config,
            companyName,
          );

          if (evalRes.ok && evalRes.match) {
            let emailData = { email: '', source: '', validation: '' };
            if (config.emailFinderEnabled) {
              await this.updateProgress(
                this.results.length,
                maxResults,
                `Finding email for: ${person.name}...`,
              );
              try {
                const nameParts = (person.name || '').trim().split(/\s+/);
                const firstName = nameParts[0] || '';
                const lastName = nameParts.slice(1).join(' ') || '';
                const emailResult = await findEmail(
                  fullProfile.publicIdentifier || person.profileId,
                  {
                    firstName,
                    lastName,
                    companyName,
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
                  `[PeopleFinder] Email finder failed for ${person.name}:`,
                  emailErr,
                );
              }
            }

            this.addResult({
              name: person.name,
              linkedinUrl: buildLinkedInProfileUrl(
                fullProfile.publicIdentifier,
                person.profileId,
              ),
              description: `Headline: ${fullProfile.headline || 'None'}\nAbout: ${fullProfile.about || 'None'}\nExperiences: ${fullProfile.experiences?.map((e) => `${e.title} at ${e.companyName}`).join(' | ') || 'None'}\nSkills: ${fullProfile.skills?.join(', ') || 'None'}`,
              profileId: person.profileId,
              headline: fullProfile.headline,
              currentRole: fullProfile.experiences[0]?.title || '',
              company: companyName,
              location: person.location || fullProfile.location || 'Unknown',
              matchReason: evalRes.reason,
              entityUrn: fullProfile.entityUrn || person.entityUrn,
              email: emailData.email,
              emailSource: emailData.source,
              emailValidation: emailData.validation,
              emailDraft: emailData.emailDraft,
            });
            if (emailData.email) {
              await addActivityEntry(
                `⭐ Found match & email: ${person.name} (${emailData.email})`,
              );
            } else {
              await addActivityEntry(`⭐ Found match: ${person.name}`);
            }
            await this.saveState();
          }
        } catch (err) {
          const isResourceError =
            err.message.includes('→ 403') || err.message.includes('→ 404');
          if (isResourceError) {
            console.warn(
              `[PeopleFinder] Profile ${person.name} (${person.profileId}) is inaccessible or private (403/404). Skipping.`,
            );
            await addActivityEntry(
              `⏭️ Skipping ${person.name} (profile inaccessible/private)`,
            );
            this.onApiSuccess(); // The network/session is healthy, this is just a bad/malformed profile
            continue;
          }
          await this.onApiFailure(err, `Evaluate ${person.name}`);
          // If onApiFailure didn't throw, we continue to the next person
        }
      }

      if (!newProfilesFound) {
        noNewResultsCount++;
        if (noNewResultsCount >= 2) {
          hasMore = false;
        }
      } else {
        noNewResultsCount = 0;
      }

      this._pageStart += meta.count || 12;
      await this.saveState();
    }

    await this.updateProgress(this.results.length, maxResults, 'Complete');
  }
}

// ─── Register ────────────────────────────────────────────────────

if (typeof globalThis !== 'undefined') {
  Object.assign(globalThis, { PeopleFinderWorkflow });
  WorkflowRegistry.register(new PeopleFinderWorkflow());
}
