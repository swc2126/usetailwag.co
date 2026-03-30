"use strict";
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  Header, Footer, AlignmentType, HeadingLevel, BorderStyle, WidthType,
  ShadingType, VerticalAlign, PageNumber, PageBreak, LevelFormat,
  ExternalHyperlink
} = require("docx");
const fs = require("fs");

// ── Color palette ──────────────────────────────────────────────────────────
const GREEN      = "1E6B4A";   // dark green accent
const NEARBLACK  = "0F1410";   // heading text
const OFFWHITE   = "F5F0E8";   // table header text
const LIGHTGRAY  = "EEEEEE";   // table zebra row
const CODEBG     = "F2F2F2";   // code block background
const WHITE      = "FFFFFF";
const MIDGRAY    = "CCCCCC";   // borders

// ── Helpers ────────────────────────────────────────────────────────────────

/** Standard cell border definition */
const cellBorder = (color = MIDGRAY) => ({
  top:    { style: BorderStyle.SINGLE, size: 1, color },
  bottom: { style: BorderStyle.SINGLE, size: 1, color },
  left:   { style: BorderStyle.SINGLE, size: 1, color },
  right:  { style: BorderStyle.SINGLE, size: 1, color },
});

/** Thin green rule below section title */
const greenRule = () => new Paragraph({
  border: { bottom: { style: BorderStyle.SINGLE, size: 8, color: GREEN, space: 4 } },
  spacing: { after: 0 },
  children: [],
});

/** Empty spacer paragraph */
const spacer = (pts = 80) => new Paragraph({ spacing: { before: pts, after: 0 }, children: [] });

/** Section heading with green background bar */
function sectionHeading(label) {
  return [
    new Paragraph({
      spacing: { before: 320, after: 0 },
      shading: { fill: GREEN, type: ShadingType.CLEAR },
      children: [
        new TextRun({
          text: label,
          bold: true,
          size: 28,         // 14pt
          color: OFFWHITE,
          font: "Arial",
          allCaps: true,
        }),
      ],
    }),
    spacer(80),
  ];
}

/** Sub-heading (H2 style) */
function subHeading(text) {
  return new Paragraph({
    spacing: { before: 220, after: 60 },
    children: [
      new TextRun({ text, bold: true, size: 24, color: NEARBLACK, font: "Arial" }),
    ],
  });
}

/** Normal body paragraph */
function body(text, options = {}) {
  return new Paragraph({
    spacing: { before: 80, after: 80 },
    children: [new TextRun({ text, size: 20, color: NEARBLACK, font: "Arial", ...options })],
  });
}

/** Bullet item using numbering reference */
function bullet(text, ref = "bullets") {
  return new Paragraph({
    numbering: { reference: ref, level: 0 },
    spacing: { before: 40, after: 40 },
    children: [new TextRun({ text, size: 20, color: NEARBLACK, font: "Arial" })],
  });
}

/** Bold label + normal text in same paragraph */
function labeledLine(label, text) {
  return new Paragraph({
    spacing: { before: 60, after: 60 },
    children: [
      new TextRun({ text: label, bold: true, size: 20, color: NEARBLACK, font: "Arial" }),
      new TextRun({ text, size: 20, color: NEARBLACK, font: "Arial" }),
    ],
  });
}

/** Code-block style paragraph */
function code(text) {
  return new Paragraph({
    spacing: { before: 40, after: 40 },
    shading: { fill: CODEBG, type: ShadingType.CLEAR },
    children: [new TextRun({ text, font: "Courier New", size: 18, color: "444444" })],
  });
}

// ── Table builder helpers ──────────────────────────────────────────────────

const CONTENT_WIDTH = 9360; // US Letter, 1-inch margins

function makeHeaderCell(text, widthDxa, isFirst = false) {
  return new TableCell({
    width: { size: widthDxa, type: WidthType.DXA },
    shading: { fill: GREEN, type: ShadingType.CLEAR },
    borders: cellBorder(GREEN),
    margins: { top: 100, bottom: 100, left: 140, right: 140 },
    verticalAlign: VerticalAlign.CENTER,
    children: [new Paragraph({
      alignment: AlignmentType.LEFT,
      children: [new TextRun({ text, bold: true, size: 18, color: OFFWHITE, font: "Arial" })],
    })],
  });
}

function makeCell(text, widthDxa, shade = WHITE, bold = false) {
  return new TableCell({
    width: { size: widthDxa, type: WidthType.DXA },
    shading: { fill: shade, type: ShadingType.CLEAR },
    borders: cellBorder(MIDGRAY),
    margins: { top: 80, bottom: 80, left: 140, right: 140 },
    verticalAlign: VerticalAlign.CENTER,
    children: [new Paragraph({
      children: [new TextRun({ text, size: 18, color: NEARBLACK, font: "Arial", bold })],
    })],
  });
}

function makeCodeCell(text, widthDxa) {
  return new TableCell({
    width: { size: widthDxa, type: WidthType.DXA },
    shading: { fill: CODEBG, type: ShadingType.CLEAR },
    borders: cellBorder(MIDGRAY),
    margins: { top: 80, bottom: 80, left: 140, right: 140 },
    verticalAlign: VerticalAlign.CENTER,
    children: [new Paragraph({
      children: [new TextRun({ text, size: 18, font: "Courier New", color: "444444" })],
    })],
  });
}

// Row shading alternates WHITE / LIGHTGRAY
function dataRow(cells, rowIndex) {
  const shade = rowIndex % 2 === 0 ? WHITE : LIGHTGRAY;
  return { cells, shade };
}

// ── Page-break helper ──────────────────────────────────────────────────────
const pageBreak = () => new Paragraph({ children: [new PageBreak()] });

// ══════════════════════════════════════════════════════════════════════════
// SECTION CONTENT BUILDERS
// ══════════════════════════════════════════════════════════════════════════

function buildCoverPage() {
  return [
    spacer(2000),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 0, after: 120 },
      shading: { fill: GREEN, type: ShadingType.CLEAR },
      children: [
        new TextRun({ text: "TailWag", bold: true, size: 72, color: OFFWHITE, font: "Arial" }),
      ],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 0, after: 200 },
      children: [
        new TextRun({ text: "Technical Brief", size: 40, color: NEARBLACK, font: "Arial" }),
      ],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 0, after: 80 },
      children: [
        new TextRun({ text: "AI-Powered SMS Platform for Independent Dog Daycares", size: 24, color: "555555", font: "Arial", italics: true }),
      ],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 200, after: 80 },
      children: [
        new TextRun({ text: "Prepared for Technical Onboarding", size: 20, color: "555555", font: "Arial" }),
      ],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 0, after: 80 },
      children: [
        new TextRun({ text: "March 2026", size: 20, color: "555555", font: "Arial" }),
      ],
    }),
    spacer(400),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 0, after: 80 },
      children: [
        new TextRun({ text: "Live URL: ", bold: true, size: 20, color: NEARBLACK, font: "Arial" }),
        new TextRun({ text: "https://usetailwag-co.onrender.com", size: 20, color: GREEN, font: "Arial" }),
      ],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 0, after: 80 },
      children: [
        new TextRun({ text: "Production Domain: ", bold: true, size: 20, color: NEARBLACK, font: "Arial" }),
        new TextRun({ text: "usetailwag.co", size: 20, color: GREEN, font: "Arial" }),
        new TextRun({ text: " (DNS cutover pending)", size: 20, color: "888888", font: "Arial", italics: true }),
      ],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 0, after: 80 },
      children: [
        new TextRun({ text: "Repository: ", bold: true, size: 20, color: NEARBLACK, font: "Arial" }),
        new TextRun({ text: "github.com/swc2126/usetailwag.co", size: 20, color: GREEN, font: "Arial" }),
      ],
    }),
    pageBreak(),
  ];
}

function buildSection1() {
  return [
    ...sectionHeading("1. Executive Summary"),
    body("TailWag is a multi-tenant SaaS platform built for independent dog daycares. It automates three core workflows: AI-generated daily report card SMS to pet parents, appointment reminders with YES/NO confirmation, and review request generation."),
    spacer(80),
    body("The platform is live at https://usetailwag-co.onrender.com and the production domain usetailwag.co is pending DNS cutover. The codebase is at github.com/swc2126/usetailwag.co."),
    spacer(80),
    body("As of late March 2026, the product is in late-stage MVP with one pilot customer (Cosmic Canine, Plano TX) and is actively being sold via in-person outreach in the Dallas-Fort Worth market."),
    spacer(160),
  ];
}

function buildSection2() {
  // 3-col table: Layer | Technology | Notes
  const cols = [2200, 2800, 4360];
  const rows = [
    ["Runtime",        "Node.js + Express",        "Server-side only, no frontend framework"],
    ["Database",       "Supabase (PostgreSQL)",     "Auth, RLS, storage"],
    ["Hosting",        "Render",                   "Service: usetailwag-co"],
    ["SMS",            "Twilio",                   "A2P 10DLC registration PENDING"],
    ["AI",             "Anthropic Claude Haiku",   "Report cards + review request generation"],
    ["Email",          "Resend REST API",          "Transactional email via utils/email.js"],
    ["Payments",       "Stripe",                   "Subscriptions + add-ons"],
    ["Source Control", "GitHub",                   "repo: swc2126/usetailwag.co"],
    ["Frontend",       "Vanilla HTML/CSS/JS",       "No bundler, no framework"],
  ];

  const tableRows = [
    new TableRow({
      tableHeader: true,
      children: [
        makeHeaderCell("Layer",      cols[0]),
        makeHeaderCell("Technology", cols[1]),
        makeHeaderCell("Notes",      cols[2]),
      ],
    }),
    ...rows.map((r, i) => new TableRow({
      children: [
        makeCell(r[0], cols[0], i%2===0 ? WHITE : LIGHTGRAY, true),
        makeCell(r[1], cols[1], i%2===0 ? WHITE : LIGHTGRAY),
        makeCell(r[2], cols[2], i%2===0 ? WHITE : LIGHTGRAY),
      ],
    })),
  ];

  return [
    ...sectionHeading("2. Tech Stack"),
    new Table({
      width: { size: CONTENT_WIDTH, type: WidthType.DXA },
      columnWidths: cols,
      rows: tableRows,
    }),
    spacer(160),
  ];
}

function buildSection3() {
  const cols = [2000, 2000, 2000, 3360];
  const rows = [
    ["Render",               "Starter",          "~$7-25/mo",    "Scales with traffic"],
    ["Supabase",             "Free -> Pro",       "$0 -> $25/mo", "Storage, bandwidth overages"],
    ["Twilio",               "Pay-as-you-go",     "~$1/mo per number", "$0.0079/SMS outbound, $0.0075/SMS inbound"],
    ["Anthropic Claude Haiku","Pay-as-you-go",    "Varies",       "$0.25/1M input tokens, $1.25/1M output tokens"],
    ["Resend",               "Free -> Scale",     "$0 -> $20/mo", "Free: 3,000 emails/mo; Scale: 50,000/mo"],
    ["Stripe",               "Pay-as-you-go",     "$0",           "2.9% + $0.30 per transaction"],
    ["GitHub",               "Free",              "$0",           "-"],
  ];

  const tableRows = [
    new TableRow({
      tableHeader: true,
      children: [
        makeHeaderCell("Service",            cols[0]),
        makeHeaderCell("Plan",               cols[1]),
        makeHeaderCell("Monthly Cost",       cols[2]),
        makeHeaderCell("Usage-Based Costs",  cols[3]),
      ],
    }),
    ...rows.map((r, i) => new TableRow({
      children: [
        makeCell(r[0], cols[0], i%2===0 ? WHITE : LIGHTGRAY, true),
        makeCell(r[1], cols[1], i%2===0 ? WHITE : LIGHTGRAY),
        makeCell(r[2], cols[2], i%2===0 ? WHITE : LIGHTGRAY),
        makeCell(r[3], cols[3], i%2===0 ? WHITE : LIGHTGRAY),
      ],
    })),
  ];

  return [
    ...sectionHeading("3. Service Costs"),
    new Table({
      width: { size: CONTENT_WIDTH, type: WidthType.DXA },
      columnWidths: cols,
      rows: tableRows,
    }),
    spacer(120),
    body("Estimated platform cost per active location per month at moderate usage (50 dogs, 20 SMS/day): ~$12-18/mo in variable costs. Gross margin on $189/mo Starter plan: ~$170+."),
    spacer(160),
  ];
}

function buildSection4() {
  return [
    ...sectionHeading("4. Architecture"),

    subHeading("Multi-Tenant Data Model"),
    body("Every record in the database is scoped by daycare_id. The Supabase Row Level Security (RLS) policies enforce that users can only read/write data belonging to their daycare. The requireAuth middleware (middleware/auth.js) decodes the JWT from localStorage (tailwag_session), looks up the user's role, and attaches req.user to every authenticated request."),

    subHeading("Role Hierarchy"),
    bullet("Owner — daycare owner; identified by daycares.owner_id = user.id; full access including billing"),
    bullet("Admin — site manager; stored in team_members with role='admin'; same dashboard access as owner"),
    bullet("Staff — team member; stored in team_members with role='staff'; messaging + directory access only"),
    body("In the UI, Owner and Admin are displayed as \"Site Manager\"; Staff is displayed as \"Team Member\"."),

    subHeading("CEO / Developer View"),
    body("A separate CEO dashboard (ceo-dashboard.html + routes/ceo.js) is available to the TailWag developer/owner (Summer). It queries all daycares where owner_id = req.user.id, aggregates stats across all locations, and shows a cross-location table of all pet parents. This view is not accessible to site managers or team members."),

    subHeading("Authentication Flow"),
    bullet("User logs in -> POST /api/auth/login -> Supabase signInWithPassword -> returns JWT stored in localStorage as tailwag_session", "numbers"),
    bullet("Every API request sends Authorization: Bearer <token> header", "numbers"),
    bullet("requireAuth middleware verifies token via Supabase, looks up profile + role", "numbers"),
    bullet("Role checked against route requirements (requireAdmin blocks staff)", "numbers"),

    subHeading("Invite Flow (Team Members)"),
    bullet("Site Manager enters email on team.html -> POST /api/team/invite", "numbers"),
    bullet("Server generates crypto.randomBytes(32) token, stores in team_members.invite_token with 7-day expiry", "numbers"),
    bullet("Resend sends branded invite email with link to /join.html?token=<token>", "numbers"),
    bullet("Staff visits join.html -> GET /api/auth/lookup-invite?token validates token, pre-fills daycare name + role", "numbers"),
    bullet("Staff enters name + password -> POST /api/auth/join creates Supabase user, activates team_members record, nulls out token", "numbers"),
    bullet("Redirected to dashboard.html", "numbers"),
    spacer(160),
  ];
}

function buildSection5() {
  const tables = [
    {
      name: "daycares",
      fields: "id (UUID, PK), name, owner_id (FK -> auth.users), plan, stripe_customer_id, stripe_subscription_id, city, state, phone, google_link, sms_limit, created_at",
    },
    {
      name: "profiles",
      fields: "id (UUID, PK = auth.users.id), first_name, last_name, phone, email, created_at",
    },
    {
      name: "clients (Pet Parents)",
      fields: "id (UUID, PK), daycare_id, first_name, last_name, phone, email, notes, review_requested_at (TIMESTAMPTZ), review_received_at (TIMESTAMPTZ), created_at",
    },
    {
      name: "dogs",
      fields: "id (UUID, PK), daycare_id, client_id (FK -> clients), name, breed, age, weight, color, medications, notes, created_at",
    },
    {
      name: "messages",
      fields: "id (UUID, PK), daycare_id, client_id, dog_id, sender_id (FK -> auth.users), direction ('outbound'|'inbound'), body, twilio_sid, created_at",
    },
    {
      name: "team_members",
      fields: "id (UUID, PK), daycare_id, user_id (FK -> auth.users), role ('admin'|'staff'), invite_token (TEXT UNIQUE), invite_expires_at (TIMESTAMPTZ), created_at",
    },
    {
      name: "appointments",
      fields: "id (UUID, PK), daycare_id, client_id, dog_id, appointment_date (DATE), status ('pending'|'confirmed'|'cancelled'), reminder_sent_at (TIMESTAMPTZ), confirmed_at (TIMESTAMPTZ), is_recurring (BOOLEAN), recurrence_days (TEXT[]), created_by (FK -> auth.users), created_at",
    },
    {
      name: "newsletter_subscribers",
      fields: "id (UUID, PK), email (TEXT UNIQUE), subscribed_at (TIMESTAMPTZ), source (TEXT DEFAULT 'homepage')",
    },
  ];

  const cols = [2400, 6960];
  const rows = tables.map((t, i) => new TableRow({
    children: [
      makeCell(t.name, cols[0], i%2===0 ? WHITE : LIGHTGRAY, true),
      makeCell(t.fields, cols[1], i%2===0 ? WHITE : LIGHTGRAY),
    ],
  }));

  return [
    ...sectionHeading("5. Database Schema"),
    new Table({
      width: { size: CONTENT_WIDTH, type: WidthType.DXA },
      columnWidths: cols,
      rows: [
        new TableRow({
          tableHeader: true,
          children: [
            makeHeaderCell("Table",  cols[0]),
            makeHeaderCell("Fields", cols[1]),
          ],
        }),
        ...rows,
      ],
    }),
    spacer(160),
  ];
}

function buildSection6() {
  const fileTree = [
    "/",
    "├── server.js                    # Express entry point",
    "├── middleware/",
    "│   └── auth.js                  # requireAuth, requireAdmin middleware",
    "├── routes/",
    "│   ├── auth.js                  # login, signup, me, profile, lookup-invite, join",
    "│   ├── clients.js               # CRUD for pet parents",
    "│   ├── dogs.js                  # CRUD for dogs",
    "│   ├── messages.js              # SMS send/receive, Twilio webhook",
    "│   ├── team.js                  # Team management, invite flow",
    "│   ├── reviews.js               # Review request/received timestamps",
    "│   ├── dashboard.js             # Dashboard stats",
    "│   ├── admin-report.js          # Site manager report (owner/admin only)",
    "│   ├── ceo.js                   # Multi-location CEO overview",
    "│   ├── appointments.js          # Appointment scheduling + reminders",
    "│   ├── ai.js                    # Claude Haiku: report cards + review requests",
    "│   ├── import.js                # CSV bulk import of clients + dogs",
    "│   ├── newsletter.js            # Newsletter signup (The Pickup Line)",
    "│   ├── shortlinks.js            # URL shortener for SMS links",
    "│   └── media.js                 # File/media handling",
    "├── utils/",
    "│   ├── supabase.js              # supabaseAdmin client",
    "│   └── email.js                 # sendEmail(), sendTeamInvite() via Resend",
    "└── public/",
    "    ├── index.html               # Marketing homepage",
    "    ├── signup.html              # New customer signup + Stripe",
    "    ├── login.html               # Auth",
    "    ├── forgot-password.html     # Password reset",
    "    ├── join.html                # Team member invite registration",
    "    ├── dashboard.html           # Main dashboard",
    "    ├── clients.html             # Directory (pet parents + dogs)",
    "    ├── messaging.html           # SMS messaging center",
    "    ├── reviews.html             # Review tracking + AI request generation",
    "    ├── team.html                # Team management + invite",
    "    ├── settings.html            # Daycare settings",
    "    ├── admin-report.html        # Site manager at-a-glance report",
    "    ├── ceo-dashboard.html       # Multi-location CEO view",
    "    ├── profile.html             # User profile (name, phone, password)",
    "    ├── schedule.html            # Appointment scheduling",
    "    ├── import.html              # Bulk CSV import",
    "    └── js/",
    "        └── nav-user.js          # Shared nav widget (initials, name, role badge, dropdown)",
  ];

  return [
    ...sectionHeading("6. File Structure"),
    ...fileTree.map(line => new Paragraph({
      spacing: { before: 0, after: 0 },
      shading: { fill: CODEBG, type: ShadingType.CLEAR },
      children: [new TextRun({ text: line, font: "Courier New", size: 16, color: "333333" })],
    })),
    spacer(160),
  ];
}

function buildSection7() {
  const groups = [
    {
      name: "Auth — /api/auth",
      routes: [
        ["POST /login",                  "Supabase email/password login, returns JWT session"],
        ["POST /signup",                 "Creates daycare + owner account + Stripe customer"],
        ["GET /me",                      "Returns profile + role + daycare (uses requireAuth)"],
        ["PUT /profile",                 "Updates first_name, last_name, phone; syncs Supabase auth metadata"],
        ["GET /lookup-invite?token",     "Validates invite token (public), returns daycare + role pre-fill"],
        ["POST /join",                   "Creates user from invite token, activates team_members record"],
      ],
    },
    {
      name: "Clients (Pet Parents) — /api/clients",
      routes: [
        ["GET /",     "List all clients for daycare (requireAuth)"],
        ["POST /",    "Create new client"],
        ["PUT /:id",  "Update client"],
        ["DELETE /:id","Delete client"],
      ],
    },
    {
      name: "Dogs — /api/dogs",
      routes: [
        ["GET /",      "List dogs (optionally filter by client_id)"],
        ["POST /",     "Create dog"],
        ["PUT /:id",   "Update dog"],
        ["DELETE /:id","Delete dog"],
      ],
    },
    {
      name: "Messages — /api/messages",
      routes: [
        ["POST /send",             "Send SMS via Twilio"],
        ["GET /thread/:clientId",  "Message thread for a client"],
        ["POST /twilio-webhook",   "Inbound SMS handler (Twilio posts here)"],
      ],
    },
    {
      name: "Team — /api/team",
      routes: [
        ["GET /",       "List team members with profiles (requireAuth)"],
        ["POST /invite","Create invite + send email (requireAdmin)"],
        ["DELETE /:id", "Remove team member (requireAdmin)"],
      ],
    },
    {
      name: "Reviews — /api/reviews",
      routes: [
        ["GET /clients",                        "List clients with review status"],
        ["PATCH /client/:clientId/requested",   "Stamp review_requested_at"],
        ["PATCH /client/:clientId/received",    "Stamp review_received_at"],
        ["DELETE /client/:clientId/received",   "Clear review_received_at"],
      ],
    },
    {
      name: "AI — /api/ai",
      routes: [
        ["POST /report-card",    "Generate personalized dog report card (Claude Haiku)"],
        ["POST /review-request", "Generate compelling review request SMS using full dog + owner profile"],
      ],
    },
    {
      name: "Admin Report — /api/admin-report",
      routes: [
        ["GET /", "This month stats, 6-month trend, staff usage, review funnel (requireAdmin)"],
      ],
    },
    {
      name: "CEO — /api/ceo",
      routes: [
        ["GET /overview", "All locations + rolled-up stats for owner_id = current user"],
      ],
    },
    {
      name: "Appointments — /api/appointments",
      routes: [
        ["GET /",       "List appointments by date"],
        ["POST /",      "Create appointment(s)"],
        ["PUT /:id",    "Update status (confirmed/cancelled)"],
        ["POST /remind","Send reminder SMS for tomorrow's appointments"],
      ],
    },
    {
      name: "Import — /api/import",
      routes: [
        ["POST /csv", "Bulk import clients + dogs from CSV upload"],
      ],
    },
    {
      name: "Newsletter — /api/newsletter",
      routes: [
        ["POST /subscribe", "Add email to newsletter_subscribers, send welcome email"],
      ],
    },
  ];

  const cols = [2600, 6760];
  const content = [];
  content.push(...sectionHeading("7. API Routes"));

  for (const group of groups) {
    content.push(subHeading(group.name));
    const tableRows = [
      new TableRow({
        tableHeader: true,
        children: [
          makeHeaderCell("Endpoint",    cols[0]),
          makeHeaderCell("Description", cols[1]),
        ],
      }),
      ...group.routes.map((r, i) => new TableRow({
        children: [
          makeCodeCell(r[0], cols[0]),
          makeCell(r[1], cols[1], i%2===0 ? WHITE : LIGHTGRAY),
        ],
      })),
    ];
    content.push(new Table({
      width: { size: CONTENT_WIDTH, type: WidthType.DXA },
      columnWidths: cols,
      rows: tableRows,
    }));
    content.push(spacer(80));
  }

  content.push(spacer(80));
  return content;
}

function buildSection8() {
  const cols = [2800, 3760, 2800];
  const rows = [
    ["SUPABASE_URL",          "Supabase project URL",              "Supabase dashboard -> Settings -> API"],
    ["SUPABASE_SERVICE_KEY",  "Service role key (bypasses RLS)",   "Supabase dashboard -> Settings -> API"],
    ["STRIPE_SECRET_KEY",     "Stripe secret key",                 "Stripe dashboard -> Developers -> API keys"],
    ["STRIPE_WEBHOOK_SECRET", "Stripe webhook signing secret",     "Stripe dashboard -> Webhooks"],
    ["TWILIO_ACCOUNT_SID",    "Twilio account identifier",         "Twilio console"],
    ["TWILIO_AUTH_TOKEN",     "Twilio auth token",                 "Twilio console"],
    ["TWILIO_PHONE_NUMBER",   "Sending phone number",              "Twilio console (PENDING purchase)"],
    ["ANTHROPIC_API_KEY",     "Claude API key",                    "console.anthropic.com"],
    ["RESEND_API_KEY",        "Resend email API key",              "resend.com -> API Keys"],
    ["JWT_SECRET",            "Secret for JWT signing",            "Generate: openssl rand -hex 32"],
  ];

  return [
    ...sectionHeading("8. Environment Variables"),
    body("All set in Render dashboard -> Environment tab for service: usetailwag-co"),
    spacer(80),
    new Table({
      width: { size: CONTENT_WIDTH, type: WidthType.DXA },
      columnWidths: cols,
      rows: [
        new TableRow({
          tableHeader: true,
          children: [
            makeHeaderCell("Variable",    cols[0]),
            makeHeaderCell("Description", cols[1]),
            makeHeaderCell("Where to Get",cols[2]),
          ],
        }),
        ...rows.map((r, i) => new TableRow({
          children: [
            makeCodeCell(r[0], cols[0]),
            makeCell(r[1], cols[1], i%2===0 ? WHITE : LIGHTGRAY),
            makeCell(r[2], cols[2], i%2===0 ? WHITE : LIGHTGRAY),
          ],
        })),
      ],
    }),
    spacer(160),
  ];
}

function buildSection9() {
  return [
    ...sectionHeading("9. Key Features"),

    subHeading("AI Report Cards"),
    body("Staff enters 3 words (e.g., \"ran, swam, napped\") into the messaging interface. POST /api/ai/report-card sends the dog's full profile (name, breed, age, weight, notes, medications) + staff input to Claude Haiku. Returns a 2-3 sentence personalized SMS. Model: claude-haiku-3 (~$0.001 per card at typical token counts)."),

    subHeading("AI Review Requests"),
    body("On the reviews page, selecting a pet parent auto-generates a custom review request using their name, dog name, breed, and visit notes. POST /api/ai/review-request. Staff can regenerate or edit before sending. Strict prompt rules: no \"fur baby,\" must mention dog by name, must feel warm not transactional."),

    subHeading("Review Tracking"),
    body("review_requested_at and review_received_at timestamps stored on the clients table. Staff manually marks when a review is received (Google Reviews API cannot match reviewers to clients by name). Status shown in review funnel on admin-report."),

    subHeading("Directory (clients.html)"),
    body("Sort toggle: By Pet Parent (A-Z last name) or By Dog (A-Z dog name). Two-step add modal — both pet parent AND dog info are required to complete a record, regardless of which side you start from."),

    subHeading("Appointment Reminders"),
    body("Staff marks tomorrow's dogs from the Directory at end of day. Reminders auto-send at configured time via Twilio. Pet parent replies YES/NO. Site manager gets morning confirmation summary. Recurring schedules (e.g., M/W/F regulars) auto-populate without daily staff input."),

    subHeading("Team Invites"),
    body("Site managers invite staff via email. Cryptographically secure token (32 bytes), 7-day expiry. Staff registers via /join.html, location pre-filled from invite. Token consumed on use (set to null) to prevent replay."),

    subHeading("CSV Bulk Import"),
    body("Daycares can export their existing client list from Gingr/PetExec/spreadsheet, fill in the TailWag template (owner_first_name, owner_last_name, owner_phone, owner_email, dog_name, breed, age, weight_lbs, notes), and upload at /import.html. One row per dog; pet parents deduplicated by phone number."),

    subHeading("The Pickup Line Newsletter"),
    body("Email capture section on homepage. Subscribers stored in newsletter_subscribers table. Welcome email sent via Resend on signup. Newsletter name: \"The Pickup Line - tips for independent daycare owners.\""),
    spacer(160),
  ];
}

function buildSection10() {
  return [
    ...sectionHeading("10. Navigation & Session"),

    labeledLine("Auth session: ", "localStorage key tailwag_session (JWT)"),
    labeledLine("Nav user cache: ", "localStorage key tailwag_nav_user (profile + role, cleared on profile save)"),
    labeledLine("Global role: ", "window.TailWagUserRole set by nav-user.js"),
    spacer(80),
    body("Shared nav widget: public/js/nav-user.js — injected into every dashboard page. Shows initials avatar, name, role badge (Site Manager in gold, Team Member in muted white). Dropdown: My Profile -> /profile.html, Sign Out."),
    spacer(160),
  ];
}

function buildSection11() {
  const cols = [2000, 7360];
  const plans = [
    ["Starter",  "$189/mo — up to 25 dogs"],
    ["Growth",   "$249/mo — up to 60 dogs"],
    ["Pro",      "$329/mo — 60+ dogs"],
  ];

  return [
    ...sectionHeading("11. Stripe Integration"),
    body("Plans configured in Stripe:"),
    new Table({
      width: { size: CONTENT_WIDTH, type: WidthType.DXA },
      columnWidths: cols,
      rows: [
        new TableRow({
          tableHeader: true,
          children: [
            makeHeaderCell("Plan",    cols[0]),
            makeHeaderCell("Details", cols[1]),
          ],
        }),
        ...plans.map((r, i) => new TableRow({
          children: [
            makeCell(r[0], cols[0], i%2===0 ? WHITE : LIGHTGRAY, true),
            makeCell(r[1], cols[1], i%2===0 ? WHITE : LIGHTGRAY),
          ],
        })),
      ],
    }),
    spacer(100),
    body("One-time add-on: Customer Analysis Report (Google + social review analysis, reputation audit, action plan). Stripe webhook handles subscription lifecycle events (created, updated, cancelled) -> updates daycares.plan in Supabase. Stripe customer ID and subscription ID stored on daycares table."),
    spacer(160),
  ];
}

function buildSection12() {
  return [
    ...sectionHeading("12. Twilio / SMS"),

    subHeading("Inbound SMS"),
    body("Twilio webhook -> POST /api/messages/twilio-webhook. Parses To (daycare phone), From (pet parent phone), Body. Matches to client by phone number. Stores message with direction='inbound'. Appointment confirmation replies (YES/NO) update appointment.status."),

    subHeading("Outbound SMS"),
    body("POST /api/messages/send -> Twilio REST API. Stores message with direction='outbound', captures twilio_sid."),

    spacer(100),
    new Paragraph({
      spacing: { before: 80, after: 80 },
      shading: { fill: "FFF3CD", type: ShadingType.CLEAR },
      children: [
        new TextRun({ text: "CRITICAL PENDING: ", bold: true, size: 20, color: "7B3F00", font: "Arial" }),
        new TextRun({ text: "A2P 10DLC registration. Without this, carrier filtering will block or delay messages at scale. Must register brand + campaign with Twilio before going live with paying customers.", size: 20, color: "7B3F00", font: "Arial" }),
      ],
    }),
    spacer(160),
  ];
}

function buildSection13() {
  const cols = [1200, 2800, 5360];
  const rows = [
    ["BLOCKING", "A2P 10DLC Registration",       "Register brand + campaign in Twilio console. Required for SMS delivery. Twilio account SID needed. ~1-3 week approval."],
    ["BLOCKING", "DNS Cutover",                   "Point usetailwag.co A record to Render IP in Namecheap. Add CNAME for www."],
    ["BLOCKING", "Twilio Phone Number",           "Purchase a local (972/214/469) number in Twilio console. Set webhook URL to https://usetailwag.co/api/messages/twilio-webhook"],
    ["HIGH",     "DMARC Record",                  "Add DMARC TXT record in Namecheap DNS for email deliverability. Required for invite emails to reach Gmail/Outlook reliably."],
    ["HIGH",     "End-to-End Invite Test",         "Full run: invite email -> join.html -> dashboard access. Confirm Resend delivers, token validates, role assigned correctly."],
    ["HIGH",     "Mobile Responsive Pass",         "Test all dashboard pages on iOS Safari and Android Chrome. Fix any layout breaks."],
    ["SOON",     "Appointment Reminder Scheduler", "Cron or Render scheduled job to fire POST /api/appointments/remind each evening at configurable time. Currently must be triggered manually."],
    ["SOON",     "Dog Profile Detail View",         "Inline or modal view of full dog card (medications, notes, breed, age) from Directory page."],
    ["SOON",     "AI Report Cards - Rich Context",  "Update report card generation to use full dog profile (breed, age, weight, notes, medications) same as review request generation."],
  ];

  const priorityColor = (p) => {
    if (p === "BLOCKING") return "C0392B";
    if (p === "HIGH")     return "E67E22";
    return "27AE60";
  };

  return [
    ...sectionHeading("13. Pending Items — Must Complete Before Full Launch"),
    new Table({
      width: { size: CONTENT_WIDTH, type: WidthType.DXA },
      columnWidths: cols,
      rows: [
        new TableRow({
          tableHeader: true,
          children: [
            makeHeaderCell("Priority",    cols[0]),
            makeHeaderCell("Item",        cols[1]),
            makeHeaderCell("Description", cols[2]),
          ],
        }),
        ...rows.map((r, i) => {
          const shade = i%2===0 ? WHITE : LIGHTGRAY;
          return new TableRow({
            children: [
              new TableCell({
                width: { size: cols[0], type: WidthType.DXA },
                shading: { fill: shade, type: ShadingType.CLEAR },
                borders: cellBorder(MIDGRAY),
                margins: { top: 80, bottom: 80, left: 140, right: 140 },
                verticalAlign: VerticalAlign.CENTER,
                children: [new Paragraph({
                  children: [new TextRun({ text: r[0], bold: true, size: 18, color: priorityColor(r[0]), font: "Arial" })],
                })],
              }),
              makeCell(r[1], cols[1], shade, true),
              makeCell(r[2], cols[2], shade),
            ],
          });
        }),
      ],
    }),
    spacer(160),
  ];
}

function buildSection14() {
  const items = [
    "Reviews page had a silent JS parse error (apostrophe in single-quoted template literal) causing infinite loading spinner — fixed by switching to double quotes. Watch for similar quote escaping issues in other template literals.",
    "Team page previously used Supabase PostgREST join syntax which failed because FK relationship was not in schema cache. Fixed with manual two-step query (fetch team_members -> fetch profiles by user_id array). If schema is ever reset, verify FK relationships are correctly defined.",
    "Supabase RLS policies need audit before multi-tenant production traffic. Verify all tables have policies that scope by daycare_id = (select daycare_id from team_members where user_id = auth.uid()) OR daycares.owner_id = auth.uid().",
    "CEO dashboard currently relies on owner_id matching the logged-in user's id. As TailWag grows, a separate tailwag_admins table or role flag should be introduced for the CEO/developer view.",
    "No automated test suite. All testing is manual. Recommend adding integration tests for auth flow, invite flow, and SMS webhook before significant customer growth.",
  ];

  return [
    ...sectionHeading("14. Known Issues / Technical Debt"),
    ...items.map(t => bullet(t)),
    spacer(160),
  ];
}

function buildSection15() {
  return [
    ...sectionHeading("15. Deployment"),

    labeledLine("Hosting: ",          "Render (render.com), service name: usetailwag-co"),
    labeledLine("Deploy trigger: ",   "Push to main branch on GitHub auto-deploys to Render"),
    labeledLine("Build command: ",    "npm install"),
    labeledLine("Start command: ",    "node server.js"),
    labeledLine("Repository: ",       "https://github.com/swc2126/usetailwag.co"),

    spacer(120),
    subHeading("To Deploy a Change"),
    bullet("Make code changes locally", "numbers"),
    bullet("git add <files> && git commit -m \"message\"", "numbers"),
    bullet("git push origin main", "numbers"),
    bullet("Render detects push, builds and deploys (~2-4 minutes)", "numbers"),
    bullet("Monitor at dashboard.render.com -> usetailwag-co -> Logs", "numbers"),

    spacer(120),
    new Paragraph({
      spacing: { before: 80, after: 80 },
      shading: { fill: "FFF3CD", type: ShadingType.CLEAR },
      children: [
        new TextRun({ text: "Important: ", bold: true, size: 20, color: "7B3F00", font: "Arial" }),
        new TextRun({ text: "Environment variables are set in Render dashboard, NOT in the codebase. Never commit .env files.", size: 20, color: "7B3F00", font: "Arial" }),
      ],
    }),
    spacer(160),
  ];
}

function buildSection16() {
  const cols = [2000, 3000, 4360];
  const rows = [
    ["GitHub",     "swc2126",                    "repo owner"],
    ["Render",     "(Summer's account)",          "hosting"],
    ["Supabase",   "(Summer's account)",          "project: TailWag"],
    ["Stripe",     "(Summer's account)",          "live + test keys"],
    ["Twilio",     "(Summer's account)",          "A2P registration pending"],
    ["Resend",     "(Summer's account)",          "from: summer@usetailwag.com"],
    ["Anthropic",  "(Summer's account)",          "Claude API"],
    ["Namecheap",  "(Summer's account)",          "DNS for usetailwag.co"],
    ["Calendly",   "summer-usetailwag",           "calendly.com/summer-usetailwag/30min"],
  ];

  return [
    ...sectionHeading("16. Contacts & Accounts"),
    new Table({
      width: { size: CONTENT_WIDTH, type: WidthType.DXA },
      columnWidths: cols,
      rows: [
        new TableRow({
          tableHeader: true,
          children: [
            makeHeaderCell("Service", cols[0]),
            makeHeaderCell("Login",   cols[1]),
            makeHeaderCell("Notes",   cols[2]),
          ],
        }),
        ...rows.map((r, i) => new TableRow({
          children: [
            makeCell(r[0], cols[0], i%2===0 ? WHITE : LIGHTGRAY, true),
            makeCell(r[1], cols[1], i%2===0 ? WHITE : LIGHTGRAY),
            makeCell(r[2], cols[2], i%2===0 ? WHITE : LIGHTGRAY),
          ],
        })),
      ],
    }),
    spacer(200),
    body("Document generated: March 2026. Prepared for technical handoff.", { italics: true, color: "888888" }),
  ];
}

// ══════════════════════════════════════════════════════════════════════════
// ASSEMBLE DOCUMENT
// ══════════════════════════════════════════════════════════════════════════

const allContent = [
  ...buildCoverPage(),
  ...buildSection1(),
  ...buildSection2(),
  ...buildSection3(),
  ...buildSection4(),
  ...buildSection5(),
  ...buildSection6(),
  ...buildSection7(),
  ...buildSection8(),
  ...buildSection9(),
  ...buildSection10(),
  ...buildSection11(),
  ...buildSection12(),
  ...buildSection13(),
  ...buildSection14(),
  ...buildSection15(),
  ...buildSection16(),
];

const doc = new Document({
  numbering: {
    config: [
      {
        reference: "bullets",
        levels: [{
          level: 0,
          format: LevelFormat.BULLET,
          text: "\u2022",
          alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 720, hanging: 360 } } },
        }],
      },
      {
        reference: "numbers",
        levels: [{
          level: 0,
          format: LevelFormat.DECIMAL,
          text: "%1.",
          alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 720, hanging: 360 } } },
        }],
      },
    ],
  },
  styles: {
    default: {
      document: { run: { font: "Arial", size: 20, color: NEARBLACK } },
    },
  },
  sections: [{
    properties: {
      page: {
        size: {
          width:  12240,  // 8.5 in
          height: 15840,  // 11 in
        },
        margin: {
          top:    1440,
          right:  1440,
          bottom: 1440,
          left:   1440,
        },
      },
    },
    headers: {
      default: new Header({
        children: [
          new Paragraph({
            border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: GREEN, space: 4 } },
            children: [
              new TextRun({
                text: "TailWag \u2014 Technical Brief",
                font: "Arial",
                size: 18,
                color: "555555",
                italics: true,
              }),
            ],
          }),
        ],
      }),
    },
    footers: {
      default: new Footer({
        children: [
          new Paragraph({
            alignment: AlignmentType.CENTER,
            border: { top: { style: BorderStyle.SINGLE, size: 4, color: GREEN, space: 4 } },
            children: [
              new TextRun({ text: "Page ", font: "Arial", size: 16, color: "888888" }),
              new TextRun({ children: [PageNumber.CURRENT], font: "Arial", size: 16, color: "888888" }),
              new TextRun({ text: " of ", font: "Arial", size: 16, color: "888888" }),
              new TextRun({ children: [PageNumber.TOTAL_PAGES], font: "Arial", size: 16, color: "888888" }),
            ],
          }),
        ],
      }),
    },
    children: allContent,
  }],
});

const outPath = "/Users/summer/Desktop/TailWag/TailWag_Technical_Brief.docx";
Packer.toBuffer(doc).then(buf => {
  fs.writeFileSync(outPath, buf);
  console.log("SUCCESS:", outPath);
  console.log("Size:", buf.length, "bytes");
}).catch(err => {
  console.error("ERROR:", err.message);
  process.exit(1);
});
