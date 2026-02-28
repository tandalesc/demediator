import { AnalysisResult } from "./types";

export const mockAnalysis: AnalysisResult = {
  article: {
    title: "New Study Finds Coffee Consumption Linked to Longevity",
    url: "https://example-news.com/coffee-longevity-study",
    publisher: "National News Network",
    date: "2026-02-25",
    snippet:
      "A groundbreaking new study published this week claims that drinking three or more cups of coffee per day could extend lifespan by up to 10 years, sending health enthusiasts into a frenzy.",
  },
  nodes: [
    {
      id: "article",
      title: "New Study Finds Coffee Consumption Linked to Longevity",
      url: "https://example-news.com/coffee-longevity-study",
      publisher: "National News Network",
      date: "2026-02-25",
      sourceType: "secondary-reporting",
      snippet:
        "Claims coffee could extend lifespan by 'up to 10 years' based on a new study.",
    },
    {
      id: "wire",
      title: "Coffee Study Shows Modest Correlation With Lower Mortality",
      url: "https://example-wire.com/health/coffee-mortality",
      publisher: "Associated Press",
      date: "2026-02-24",
      sourceType: "wire-service",
      snippet:
        "Researchers found a statistically significant but modest correlation between regular coffee consumption and reduced all-cause mortality.",
    },
    {
      id: "press-release",
      title:
        "University Research Team Publishes Findings on Coffee and Health Outcomes",
      url: "https://example-university.edu/news/coffee-health",
      publisher: "Midwest State University",
      date: "2026-02-23",
      sourceType: "press-release",
      snippet:
        "Our team found that participants who consumed 3+ cups daily showed a 12% reduction in all-cause mortality over the 15-year study period.",
    },
    {
      id: "study",
      title:
        "Association Between Habitual Coffee Intake and All-Cause Mortality: A Prospective Cohort Analysis",
      url: "https://example-journal.org/articles/coffee-mortality-2026",
      publisher: "Journal of Nutritional Epidemiology",
      date: "2026-02-20",
      sourceType: "primary-study",
      snippet:
        "Adjusted hazard ratio 0.88 (95% CI: 0.82-0.94) for participants consuming ≥3 cups/day vs non-drinkers. Observational design; causal inference limited.",
    },
    {
      id: "prior-study",
      title:
        "Coffee Consumption and Mortality in Three Large Prospective Cohorts",
      url: "https://example-journal.org/articles/coffee-meta-2024",
      publisher: "Circulation",
      date: "2024-06-15",
      sourceType: "primary-study",
      snippet:
        "Earlier meta-analysis showing similar but smaller effect sizes (HR 0.92). Notes significant heterogeneity across populations.",
    },
    {
      id: "industry",
      title: "National Coffee Association Applauds New Health Findings",
      url: "https://example-coffee.org/press/health-findings",
      publisher: "National Coffee Association",
      date: "2026-02-24",
      sourceType: "official-statement",
      snippet:
        "We are thrilled that science continues to confirm what coffee lovers have always known — coffee is part of a healthy lifestyle.",
    },
    {
      id: "opposing",
      title: "Nutritionists Urge Caution on Coffee-Longevity Claims",
      url: "https://example-health.com/coffee-caution",
      publisher: "Health Desk",
      date: "2026-02-25",
      sourceType: "secondary-reporting",
      snippet:
        "Several independent nutritionists note the study's observational design cannot establish causation and warn against oversimplified headlines.",
    },
  ],
  edges: [
    {
      id: "article-wire",
      source: "wire",
      target: "article",
      metrics: {
        sourceFidelity: 0.45,
        editorialization: 0.8,
        sourceType: "wire-service",
        corroboration: "partial",
      },
      concerns: [
        "Headline inflates '12% reduction in mortality' to 'extend lifespan by up to 10 years'",
        "Drops confidence interval and observational design caveat from wire copy",
        "'Groundbreaking' framing not present in any source material",
      ],
    },
    {
      id: "wire-press",
      source: "press-release",
      target: "wire",
      metrics: {
        sourceFidelity: 0.75,
        editorialization: 0.3,
        sourceType: "press-release",
        corroboration: "strong",
      },
      concerns: [
        "Drops university's specific 12% figure in favor of vaguer 'modest correlation'",
      ],
    },
    {
      id: "press-study",
      source: "study",
      target: "press-release",
      metrics: {
        sourceFidelity: 0.7,
        editorialization: 0.4,
        sourceType: "primary-study",
        corroboration: "strong",
      },
      concerns: [
        "Press release omits the study's own caution about observational limitations",
        "Converts hazard ratio to '12% reduction' without mentioning confidence interval",
      ],
    },
    {
      id: "study-prior",
      source: "prior-study",
      target: "study",
      metrics: {
        sourceFidelity: 0.9,
        editorialization: 0.1,
        sourceType: "primary-study",
        corroboration: "strong",
      },
      concerns: [
        "Cites prior study accurately but doesn't address noted population heterogeneity",
      ],
    },
    {
      id: "article-industry",
      source: "industry",
      target: "article",
      metrics: {
        sourceFidelity: 0.3,
        editorialization: 0.9,
        sourceType: "official-statement",
        corroboration: "none",
      },
      concerns: [
        "Industry statement presented as expert validation without disclosing financial interest",
        "Quote cherry-picked to support article's framing",
      ],
    },
    {
      id: "article-opposing",
      source: "opposing",
      target: "article",
      metrics: {
        sourceFidelity: 0.85,
        editorialization: 0.2,
        sourceType: "secondary-reporting",
        corroboration: "strong",
      },
      concerns: [
        "Opposing view buried at end of article, given significantly less space",
      ],
    },
  ],
  claims: {},
  summary: {
    text: "This article's source chain shows significant fidelity degradation — the original study's modest 12% mortality reduction inflates to '10 extra years of life' through successive editorial layers. 3 of 6 source links maintain strong corroboration, but the industry statement is presented without substantiation and the primary caution from nutritionists is buried.",
    overallFidelity: 0.66,
    concernCount: 7,
    strongCorroboration: 3,
    weakCorroboration: 1,
    unverifiedClaims: [
      "Coffee could extend lifespan by up to 10 years",
      "Science continues to confirm coffee is part of a healthy lifestyle",
    ],
  },
};
