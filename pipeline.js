// ─── Pipeline Engine ─────────────────────────────────────────────
// 6-step automated outreach pipeline running inside the extension.

// ─── Step 1: Job Discovery ───────────────────────────────────────

async function discoverJobs() {
  const config = await getConfig();
  const keywords = config.keywords
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
  const locations = config.locations
    .split(",")
    .map((l) => l.trim())
    .filter(Boolean);

  const TARGET_ROLES = [
    "werkstudent",
    "working student",
    "intern",
    "internship",
    "praktikum",
    "praktikant",
    "student",
    "trainee",
  ];

  await addActivityEntry("🔍 Starting job discovery...");
  const allJobs = [];

  for (const keyword of keywords) {
    for (const location of locations) {
      const status = await getPipelineStatus();
      if (status !== "running") return allJobs;

      try {
        await apiDelay();
        const response = await searchJobs(keyword, location);
        resetApiErrors();

        const jobs = parseJobSearchResults(response);
        const filtered = jobs.filter((job) => {
          const title = job.jobTitle.toLowerCase();
          return TARGET_ROLES.some((role) => title.includes(role));
        });

        allJobs.push(...filtered);
        await addActivityEntry(
          `📋 Found ${filtered.length} matching jobs for "${keyword}" in ${location}`,
        );
      } catch (err) {
        console.error("[Pipeline] Job search error:", err);
        if (trackApiError(err)) {
          await setPipelineStatus("paused");
          await addActivityEntry("⚠️ Too many API errors — pipeline paused");
          return allJobs;
        }
      }
    }
  }

  // Deduplicate by company URN
  const uniqueCompanies = new Map();
  for (const job of allJobs) {
    if (job.companyUrn && !uniqueCompanies.has(job.companyUrn)) {
      uniqueCompanies.set(job.companyUrn, job);
    }
  }

  const dedupedJobs = Array.from(uniqueCompanies.values()).slice(0, 3);
  await incrementDailyStat("jobsFound", dedupedJobs.length);
  await addActivityEntry(
    `✅ Job discovery complete (TEST LIMIT: 3): ${dedupedJobs.length} unique companies found`,
  );

  return dedupedJobs;
}

// ─── Step 2: Company Resolution ──────────────────────────────────

async function resolveCompanies(jobs) {
  await addActivityEntry(`🏢 Resolving ${jobs.length} companies...`);
  const companies = [];

  for (const job of jobs) {
    const status = await getPipelineStatus();
    if (status !== "running") return companies;

    // Extract company ID from URN (e.g., "urn:li:company:12345" → "12345")
    let companyId = job.companyUrn;
    if (companyId.includes(":")) {
      companyId = companyId.split(":").pop();
    }

    // Dedup — skip already processed
    if (await isCompanyProcessed(companyId)) {
      continue;
    }

    try {
      await apiDelay();
      const response = await getCompanyById(companyId);
      resetApiErrors();

      const company = {
        companyId,
        companyName: response.name || job.companyName || "",
        companySlug: response.universalName || "",
        employeeCount: response.staffCount || 0,
        industry: response.companyIndustries?.[0]?.localizedName || "",
        jobTitle: job.jobTitle,
        location: job.location,
      };

      companies.push(company);
      await addProcessedCompany(companyId);
      await incrementDailyStat("companiesProcessed");
    } catch (err) {
      console.warn("[Pipeline] Company resolution error for", companyId, err);
      // Don't hard fail — just skip this company
      if (trackApiError(err)) {
        await setPipelineStatus("paused");
        await addActivityEntry("⚠️ Too many API errors — pipeline paused");
        return companies;
      }
    }
  }

  await addActivityEntry(`✅ Resolved ${companies.length} companies`);
  return companies;
}

// ─── Step 3: HR Target Discovery ─────────────────────────────────

async function findHRTargets(companies) {
  const config = await getConfig();
  await addActivityEntry(
    `👥 Searching for HR targets across ${companies.length} companies...`,
  );
  const allTargets = [];

  const HR_KEYWORDS = [
    "hr",
    "recruiter",
    "recruiting",
    "talent",
    "hiring",
    "people",
    "human resources",
    "talent acquisition",
  ];

  for (const company of companies) {
    const status = await getPipelineStatus();
    if (status !== "running") return allTargets;

    try {
      await apiDelay();
      const response = await searchPeople(
        company.companyId,
        undefined,
        config.targetGeoId || "101282230",
      );
      resetApiErrors();

      let people = parsePeopleSearchResults(response);

      // Filter: must have HR keywords in headline
      people = people.filter((p) => {
        const headline = p.headline.toLowerCase();
        return HR_KEYWORDS.some((kw) => headline.includes(kw));
      });

      // TEST LIMIT: 1 target per company
      people = people.slice(0, 1);

      for (const person of people) {
        // Skip if already contacted
        if (await isProfileContacted(person.profileId)) continue;

        allTargets.push({
          ...person,
          companyName: company.companyName,
          companyId: company.companyId,
          jobTitle: company.jobTitle,
        });
      }

      if (people.length > 0) {
        await addActivityEntry(
          `👤 Found ${people.length} HR targets at ${company.companyName}`,
        );
      }
    } catch (err) {
      console.warn(
        "[Pipeline] People search error for company",
        company.companyId,
        err,
      );
      if (trackApiError(err)) {
        await setPipelineStatus("paused");
        await addActivityEntry("⚠️ Too many API errors — pipeline paused");
        return allTargets;
      }
    }
  }

  await incrementDailyStat("targetsFound", allTargets.length);
  await addActivityEntry(`✅ Found ${allTargets.length} HR targets total`);
  return allTargets;
}

// ─── Step 4: Profile Deep Fetch ──────────────────────────────────

async function fetchTargetProfiles(targets) {
  await addActivityEntry(
    `📄 Fetching detailed profiles for ${targets.length} targets...`,
  );
  const profiles = [];

  for (const target of targets) {
    const status = await getPipelineStatus();
    if (status !== "running") return profiles;

    try {
      // Pre-check: relationship status
      await apiDelay();
      const relResponse = await checkRelationship(target.profileId);
      const rel = parseRelationship(relResponse);

      if (rel.isConnected) {
        await addActivityEntry(
          `⏭ Skipping ${target.name} — already connected`,
        );
        await addContactedProfile(target.profileId);
        continue;
      }
      if (rel.isPending) {
        await addActivityEntry(
          `⏭ Skipping ${target.name} — invitation pending`,
        );
        await addContactedProfile(target.profileId);
        continue;
      }

      // Fetch full profile
      await apiDelay();
      const profileResponse = await fetchFullProfile(target.profileId);
      resetApiErrors();
      const profile = parseFullProfile(profileResponse);

      profiles.push({
        ...target,
        profile,
        memberId: profile.memberId || target.profileId, // Use persistent ID if found
        connectionDegree: rel.distance,
      });
    } catch (err) {
      console.warn("[Pipeline] Profile fetch error for", target.profileId, err);
      if (trackApiError(err)) {
        await setPipelineStatus("paused");
        await addActivityEntry("⚠️ Too many API errors — pipeline paused");
        return profiles;
      }
    }
  }

  await addActivityEntry(`✅ Fetched ${profiles.length} full profiles`);
  return profiles;
}

// ─── Step 5: AI Message Generation ───────────────────────────────

async function generateMessages(profiles) {
  const config = await getConfig();
  await addActivityEntry(
    `✍️ Generating personalized messages for ${profiles.length} targets...`,
  );

  // Health check LLM first
  const health = await llmHealthCheck(config.llmUrl);
  if (!health.ok) {
    await addActivityEntry(
      `⚠️ LLM unreachable at ${config.llmUrl} — ${health.error}`,
    );
    await addActivityEntry("⏸ Pausing — configure LLM URL in settings");
    await setPipelineStatus("paused");
    return [];
  }

  const ready = [];

  for (const target of profiles) {
    const status = await getPipelineStatus();
    if (status !== "running") return ready;

    try {
      const result = await generateConnectionMessage(
        target.profile,
        target.companyName,
        config.userContext,
        config,
      );

      if (result.ok && result.message) {
        ready.push({
          ...target,
          message: result.message,
        });
        await addActivityEntry(
          `💬 Message generated for ${target.name} (${result.message.length} chars)`,
        );
      } else {
        await addActivityEntry(
          `⚠️ LLM failed for ${target.name}: ${result.error}`,
        );
      }
    } catch (err) {
      console.warn("[Pipeline] Message generation error:", err);
      await addActivityEntry(`⚠️ Message generation error for ${target.name}`);
    }
  }

  await addActivityEntry(`✅ Generated ${ready.length} messages`);
  return ready;
}

// ─── Step 6: Send Connection Requests ────────────────────────────

async function sendConnections(targets) {
  await addActivityEntry(
    `📨 Sending connection requests to ${targets.length} targets...`,
  );
  let sent = 0;

  for (const target of targets) {
    const status = await getPipelineStatus();
    if (status !== "running") break;

    // Check daily limit
    if (!(await canSendConnection())) {
      await addActivityEntry(
        "🛑 Daily connection limit reached — stopping for today",
      );
      break;
    }

    try {
      // Use persistent memberId (ACoAA...) for the actual invitation
      const targetId = target.memberId || target.profileId;
      await sendConnectionRequest(targetId, target.message);
      resetApiErrors();

      await addContactedProfile(target.profileId);
      await incrementDailyStat("connectionsSent");
      sent++;

      // Log the outreach
      await addLogEntry({
        name: target.name,
        profileId: target.profileId,
        company: target.companyName,
        message: target.message,
        status: "sent",
      });

      await addActivityEntry(
        `✅ Connection sent to ${target.name} at ${target.companyName}`,
      );

      // Human-like delay between connection requests (2-5 min)
      if (sent < targets.length) {
        const remaining = await getRemainingSlots();
        if (remaining > 0) {
          await addActivityEntry(
            `⏳ Waiting 2-5 min before next connection...`,
          );
          await connectionDelay();
        }
      }
    } catch (err) {
      console.error(
        "[Pipeline] Connection send error for",
        target.profileId,
        err,
      );
      await addLogEntry({
        name: target.name,
        profileId: target.profileId,
        company: target.companyName,
        message: target.message,
        status: "failed",
        error: err.message,
      });
      await addActivityEntry(
        `❌ Failed to connect with ${target.name}: ${err.message}`,
      );

      if (trackApiError(err)) {
        await setPipelineStatus("paused");
        await addActivityEntry("⚠️ Too many API errors — pipeline paused");
        break;
      }
    }
  }

  await addActivityEntry(
    `📊 Pipeline complete: ${sent} connections sent today`,
  );
  return sent;
}

// ─── Full Pipeline Runner ────────────────────────────────────────

async function runPipeline() {
  console.log("[Pipeline] Starting full pipeline run...");
  await setPipelineStatus("running");
  await addActivityEntry("🚀 Pipeline started");

  try {
    // Validate session first
    const sessionValid = await validateSession();
    if (!sessionValid) return;

    // Step 1: Job Discovery
    const jobs = await discoverJobs();
    if ((await getPipelineStatus()) !== "running") return;
    if (jobs.length === 0) {
      await addActivityEntry("ℹ️ No matching jobs found — pipeline complete");
      await setPipelineStatus("idle");
      return;
    }

    // Step 2: Company Resolution
    const companies = await resolveCompanies(jobs);
    if ((await getPipelineStatus()) !== "running") return;
    if (companies.length === 0) {
      await addActivityEntry(
        "ℹ️ All companies already processed — pipeline complete",
      );
      await setPipelineStatus("idle");
      return;
    }

    // Step 3: HR Target Discovery
    const targets = await findHRTargets(companies);
    if ((await getPipelineStatus()) !== "running") return;
    if (targets.length === 0) {
      await addActivityEntry("ℹ️ No new HR targets found — pipeline complete");
      await setPipelineStatus("idle");
      return;
    }

    // Step 4: Profile Deep Fetch
    const profiles = await fetchTargetProfiles(targets);
    if ((await getPipelineStatus()) !== "running") return;
    if (profiles.length === 0) {
      await addActivityEntry(
        "ℹ️ All targets already connected — pipeline complete",
      );
      await setPipelineStatus("idle");
      return;
    }

    // Step 5: AI Message Generation
    const ready = await generateMessages(profiles);
    if ((await getPipelineStatus()) !== "running") return;
    if (ready.length === 0) {
      await addActivityEntry("⚠️ No messages generated — check LLM settings");
      await setPipelineStatus("idle");
      return;
    }

    // Step 6: Send Connections
    await sendConnections(ready);

    const finalStatus = await getPipelineStatus();
    if (finalStatus === "running") {
      await setPipelineStatus("idle");
      await addActivityEntry("✅ Pipeline run complete!");
    }
  } catch (err) {
    console.error("[Pipeline] Fatal error:", err);
    await addActivityEntry(`❌ Pipeline error: ${err.message}`);
    await setPipelineStatus("paused");
  }
}

// ─── Exports ─────────────────────────────────────────────────────

if (typeof globalThis !== "undefined") {
  Object.assign(globalThis, {
    discoverJobs,
    resolveCompanies,
    findHRTargets,
    fetchTargetProfiles,
    generateMessages,
    sendConnections,
    runPipeline,
  });
}
