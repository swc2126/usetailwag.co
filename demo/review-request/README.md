# TailWag — Review & Social Request

The review and social post request logic is built directly into the
Report Card Generator and triggers automatically from that workflow.

## How it works

1. Staff sends a report card and toggles "Great day?" ON
2. The system checks the owner's review status:
   - Never left a Google review → sends a Google review request
   - Already reviewed on Google → sends a social media post request
3. Both requests are throttled to once every 30 days per owner
4. Once an owner completes a Google review, staff marks them in the
   Owner Review Status panel — they move permanently to social requests

## Running it

Start the Report Card Generator — the review module is included:

```bash
cd ../report-card-generator
bash run.sh
```

## Config required (in config/demo_settings.txt)

```
GOOGLE_REVIEW_LINK=your_google_review_short_link
INSTAGRAM_HANDLE=@your_handle
```
