export const funnel = {
  ticket: {
    eyebrow: "Ready to get started?",
    headline: "Where should we send your free playbook?",
    submit: "Send Me The Playbook",
    submitWhen: "Free Instant Access",
    submitPending: "Sending…",
    fields: {
      name: { emoji: "👋", placeholder: "Your first name", autocomplete: "given-name" },
      lastName: { emoji: "👤", placeholder: "Your last name", autocomplete: "family-name" },
      email: { emoji: "✉️", placeholder: "Your business email", autocomplete: "email" },
      phone: { emoji: "📞", placeholder: "Your phone number", autocomplete: "tel" },
    },
    errors: {
      name: "Enter your first name.",
      email: "Enter a valid business email.",
      generic: "Check the highlighted fields and try again.",
    },
  },
  confirm: { cta: "Book A Strategy Call" },
  legal: {
    termsLabel: "Terms of use",
    privacyLabel: "Privacy policy",
    termsUrl: "/privacy",
    privacyUrl: "/privacy",
  },
  faq: [],
  quiz: { steps: [] },
  seo: {
    landingTitle: "Hot Tub Launch — One Store Per Market",
    landingDescription: "One hot tub store per market, by application.",
  },
} as const;