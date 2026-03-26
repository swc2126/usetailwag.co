# 🐾 TailWag

**TailWag** is an automated client communication platform for doggie daycares. It uses AI and SMS to send personalized report cards, appointment reminders, and review requests — keeping dog owners happy and saving staff hours every week.

---

## 📁 Folder Structure

### `demo/`
Contains the three core demo modules. Each is a self-contained script you can run to show a prospect exactly what TailWag does.

- **`demo/report-card-generator/`**
  Generates and sends personalized end-of-day SMS report cards for each dog using AI. The message tone matches the dog's personality (e.g., energetic messages for high-energy dogs, gentle ones for shy dogs).

- **`demo/reminder-system/`**
  Sends automated appointment reminder texts to dog owners before their scheduled drop-off. Reduces no-shows and last-minute cancellations.

- **`demo/review-request/`**
  Sends a friendly follow-up SMS after a dog's visit asking the owner to leave a Google or Yelp review. Helps daycares build their online reputation automatically.

### `clients/`
Stores dog and owner data used by the demo scripts.

- **`clients/demo-dogs/`**
  Contains `demo_dogs.csv` — the roster of fictional demo dogs used during sales demos. All messages route to your demo phone numbers, not real clients.

- **`clients/templates/`**
  Contains the AI prompt templates that control the tone and style of outgoing messages. Edit these to customize messaging for a specific daycare's brand voice.

### `config/`
Stores environment settings and API credentials.

- **`config/demo_settings.txt`**
  Paste your API keys and phone numbers here before running any demo. This file is gitignored — never commit real credentials.

### `logs/`
Auto-generated logs of every message sent during demos.

- **`logs/messages_log.csv`**
  A running record of all outbound messages: dog name, owner, message content, timestamp, and whether a response was received. Useful for showing prospects real demo activity.

### `business/`
Internal business documents.

- **`business/contracts/`** — Client service agreement templates.
- **`business/invoices/`** — Invoices for daycare clients.
- **`business/pitchdecks/`** — Sales decks and pitch materials.

---

## 🚀 How to Run Each Demo

> **Before running anything:** Open `config/demo_settings.txt` and fill in your API keys and demo phone numbers.

### Report Card Generator
```bash
cd demo/report-card-generator
python report_card_demo.py
```
This will loop through all dogs in `clients/demo-dogs/demo_dogs.csv`, generate a personalized AI message for each one, and send it via SMS to `DEMO_PHONE_1`.

### Reminder System
```bash
cd demo/reminder-system
python reminder_demo.py
```
Sends a simulated appointment reminder to `DEMO_PHONE_1` for each demo dog.

### Review Request
```bash
cd demo/review-request
python review_request_demo.py
```
Sends a friendly post-visit review request to `DEMO_PHONE_1` for each demo dog.

---

## 🐶 How to Add a New Demo Dog

1. Open `clients/demo-dogs/demo_dogs.csv`
2. Add a new row following this format:
   ```
   dog_name, owner_name, phone, breed, personality
   Rosie, Laura, DEMO_PHONE_1, Beagle, curious and sniff-obsessed
   ```
3. Keep `phone` set to `DEMO_PHONE_1` so messages route to your demo number — not a real client.
4. The `personality` field drives the AI message tone, so be descriptive!

---

## ⚙️ Configuration Reference

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Your Anthropic API key for AI message generation |
| `TWILIO_ACCOUNT_SID` | Your Twilio account SID |
| `TWILIO_AUTH_TOKEN` | Your Twilio auth token |
| `TWILIO_PHONE_NUMBER` | The Twilio number messages send FROM |
| `DEMO_PHONE_1` | Your cell number — all demo SMS messages go here |
| `DEMO_MODE` | Set to `true` to keep all messages routing to demo numbers only |

---

*TailWag — because every dog deserves a great report card.*
