import { describe, it, expect } from 'vitest';
import {
  parseCriteriaFromPrompt,
  evaluateJobDescription,
  generateJobsCsv,
  type ParsedSearchCriteria,
} from './jobFinder.service.js';

describe('jobFinder.service', () => {
  describe('parseCriteriaFromPrompt', () => {
    it('defaults targetCount to 20 if no number is mentioned', async () => {
      const criteria = await parseCriteriaFromPrompt(
        'working student frontend developer in Berlin without German',
      );
      expect(criteria.targetCount).toBe(20);
      expect(criteria.keywords).toContain('Frontend');
      expect(criteria.languageRule.germanRequirement).toBe('no_german');
    });

    it('extracts targetCount if explicitly stated (e.g. 100 or 50)', async () => {
      const criteria = await parseCriteriaFromPrompt(
        'I need 100 jobs for React developer in Germany without German or German optional',
      );
      expect(criteria.targetCount).toBe(100);
      expect(criteria.keywords).toContain('React');
      expect(criteria.languageRule.germanRequirement).toBe('no_german');
    });

    it('handles "German optional" requirement', async () => {
      const criteria = await parseCriteriaFromPrompt(
        'working student python backend in Munich, German is just optional, need 30',
      );
      expect(criteria.targetCount).toBe(30);
      expect(criteria.languageRule.germanRequirement).toBe('german_optional');
      expect(criteria.easyApplyOnly).toBe(false);
    });

    it('sets easyApplyOnly to true only when requested in prompt or override', async () => {
      const withEasyApply = await parseCriteriaFromPrompt(
        'React developer in Berlin Easy Apply without German',
      );
      expect(withEasyApply.easyApplyOnly).toBe(true);

      const withoutEasyApply = await parseCriteriaFromPrompt(
        'React developer in Berlin without German',
      );
      expect(withoutEasyApply.easyApplyOnly).toBe(false);

      const overridden = await parseCriteriaFromPrompt(
        'React developer in Berlin',
        undefined,
        20,
        true,
      );
      expect(overridden.easyApplyOnly).toBe(true);
    });

    it('ensures language requirements are stripped from LinkedIn search keywords and used only for JD filtering', async () => {
      const criteria = await parseCriteriaFromPrompt(
        'Golang backend engineer in Berlin without German or German optional, need 25 jobs',
      );
      expect(criteria.keywords.toLowerCase()).not.toContain('german');
      expect(criteria.keywords.toLowerCase()).not.toContain('without');
      expect(criteria.languageRule.germanRequirement).toBe('no_german');
    });
  });

  describe('evaluateJobDescription', () => {
    const noGermanCriteria: ParsedSearchCriteria = {
      keywords: 'working student',
      location: 'Berlin',
      targetCount: 20,
      timeFilter: 'r604800',
      easyApplyOnly: true,
      languageRule: {
        germanRequirement: 'no_german',
        englishRequired: true,
        explanation: 'No German required',
      },
      mustHaveKeywords: [],
      excludedKeywords: [],
    };

    it('rejects JD that explicitly requires fluent German', async () => {
      const germanJd = `
        Wir suchen ab sofort eine/n Werkstudent/in (m/w/d) im Bereich Marketing.
        Deine Aufgaben:
        - Unterstützung bei Kampagnen
        - Erstellung von Inhalten
        Das bringst du mit:
        - Fließende Deutschkenntnisse in Wort und Schrift (C1 Niveau ist Voraussetzung)
        - Sehr gute Deutschkenntnisse
      `;

      const res = await evaluateJobDescription(
        germanJd,
        'Werkstudent Marketing',
        'Acme GmbH',
        noGermanCriteria,
      );

      expect(res.passed).toBe(false);
      expect(res.languageAssessment).toContain('Mandatory German Required');
    });

    it('passes JD in English with no German requirement', async () => {
      const englishJd = `
        About The Role:
        We are looking for a Working Student FP&A to join our Berlin team.
        What You Bring:
        - Academic background in Finance or Business
        - Advanced Excel proficiency
        - Fluent in English (written and spoken)
      `;

      const res = await evaluateJobDescription(
        englishJd,
        'FP&A Working Student',
        'Shiftmove',
        noGermanCriteria,
      );

      expect(res.passed).toBe(true);
      expect(res.languageAssessment).toContain('English Working Language');
    });

    it('passes JD when German is only optional or a bonus', async () => {
      const optionalGermanJd = `
        Software Engineer Working Student:
        We are building a global cloud platform.
        Requirements:
        - Proficient in TypeScript and React
        - Excellent English communication skills
        - German is a plus or optional, but not required
      `;

      const res = await evaluateJobDescription(
        optionalGermanJd,
        'Software Engineer Working Student',
        'Tech Corp',
        noGermanCriteria,
      );

      expect(res.passed).toBe(true);
      expect(res.languageAssessment).toContain('German is Optional / Bonus');
    });

    it('passes JD with explicit negative German statements (e.g. Deutschkenntnisse nicht erforderlich)', async () => {
      const negativeGermanJd = `
        Full Stack Engineer:
        We are a fast-moving AI startup.
        Requirements:
        - Strong experience with Node.js and Postgres.
        - Fluency in English.
        - Deutschkenntnisse sind nicht erforderlich! All communication is in English.
      `;

      const res = await evaluateJobDescription(
        negativeGermanJd,
        'Full Stack Engineer',
        'AI Lab',
        noGermanCriteria,
      );

      expect(res.passed).toBe(true);
      expect(res.languageAssessment).not.toContain('Mandatory German Required');
    });

    it('gracefully rejects unreadable or truncated JDs (< 50 chars)', async () => {
      const unreadableJd = 'Access Denied / Captcha';
      const res = await evaluateJobDescription(
        unreadableJd,
        'Developer',
        'Company',
        noGermanCriteria,
      );

      expect(res.passed).toBe(false);
      expect(res.languageAssessment).toBe('JD Unreadable');
    });
  });

  describe('generateJobsCsv', () => {
    it('generates valid CSV with correct headers, escaped quotes, and sanitized newlines', () => {
      const sampleJobs = [
        {
          jobId: '12345',
          title: 'Working Student, Frontend\nSecond Line',
          company: 'Shiftmove "Tech"',
          location: 'Berlin, Germany',
          url: 'https://www.linkedin.com/jobs/view/12345',
          postedDate: '2 days ago',
          passed: true,
          fitScore: 95,
          languageAssessment: 'English Working Language',
          reason: 'Matches all criteria\nNo German needed',
          jdSnippet: 'A great role...',
        },
      ];

      const csv = generateJobsCsv(sampleJobs);
      expect(csv).toContain('Job Title,Company Name,Location,LinkedIn Job URL');
      expect(csv).toContain('"Working Student, Frontend Second Line"');
      expect(csv).toContain('"Shiftmove ""Tech"""');
      expect(csv).toContain('"https://www.linkedin.com/jobs/view/12345"');
      expect(csv).toContain('"PASSED"');
      expect(csv).not.toContain('Frontend\nSecond Line');
    });
  });
});
