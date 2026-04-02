# 🛠️ TailWag — Tools & Applications

Complete reference of every tool and platform powering TailWag.

---

## 🤖 Core Product

| Tool | Function | Notes |
|---|---|---|
| **Anthropic Claude** | AI engine that generates personalized report cards, review requests, and message content from staff notes | Powers the core product differentiator |
| **Twilio** | SMS/MMS delivery, dedicated phone number provisioning per daycare, A2P 10DLC compliance, opt-out management | All outbound texts route through Twilio |
| **Supabase** | PostgreSQL database, user authentication, file/media storage, row-level security | Multi-tenant — every table scoped by `daycare_id` |
| **Stripe** | Subscription billing, payment processing, Checkout Sessions | Handles all plans including Founder's Circle |
| **Render** | Cloud hosting and auto-deployment from GitHub | Deploys on every push to `main` |
| **Resend** | Transactional email — team invites, system notifications, access requests | Triggered by backend events, not marketing |

---

## 💬 Customer Experience & Support

| Tool | Function | Notes |
|---|---|---|
| **Intercom** | In-app chat widget, customer support, help center, user identity verification | Loaded on all authenticated pages; identity verified via JWT |
| **Brevo** | Customer service management, support email routing, contact management | Handles inbound service requests and client communications |
| **Loom** | Instructional videos and member onboarding experience | Setup walkthroughs, feature explainers, Founder's Circle onboarding |

---

## 📣 Marketing & Growth

| Tool | Function | Notes |
|---|---|---|
| **Canva** | Marketing design — social graphics, sales decks, one-pagers, ads | Brand collateral and visual content creation |

---

## 🏗️ Development & Operations

| Tool | Function | Notes |
|---|---|---|
| **GitHub** | Version control, source of truth for all code | `main` branch auto-deploys to Render |
| **Notion** | Primary CRM, internal knowledge base, project tracking, outreach log | Command center for all TailWag operations |
| **Supabase Dashboard** | Database management, SQL editor, security advisor | Run migrations and RLS policies here |

---

## 🔑 Environment Variables Reference

| Variable | Tool | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | Anthropic | AI message generation |
| `TWILIO_ACCOUNT_SID` | Twilio | Account authentication |
| `TWILIO_AUTH_TOKEN` | Twilio | Account authentication |
| `TWILIO_PHONE_NUMBER` | Twilio | Outbound SMS sender number |
| `SUPABASE_URL` | Supabase | Database connection |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase | Backend admin access (bypasses RLS) |
| `STRIPE_SECRET_KEY` | Stripe | Payment processing |
| `STRIPE_WEBHOOK_SECRET` | Stripe | Webhook signature verification |
| `RESEND_API_KEY` | Resend | Transactional email sending |
| `INTERCOM_SECRET` | Intercom | JWT identity verification |

---

*Last updated: April 2026*
