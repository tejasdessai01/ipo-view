#!/bin/bash
# Deploy the refresh Cloud Function
#
# Prerequisites:
#   1. Install gcloud CLI: https://cloud.google.com/sdk/docs/install
#   2. Authenticate:       gcloud auth login
#   3. Set project:        gcloud config set project YOUR_PROJECT_ID
#   4. Enable APIs:        gcloud services enable cloudfunctions.googleapis.com cloudbuild.googleapis.com cloudscheduler.googleapis.com
#
# Usage:
#   cd gcf-refresh
#   chmod +x deploy.sh
#   ./deploy.sh

set -euo pipefail

PROJECT_ID=$(gcloud config get-value project)
REGION="asia-south1"   # Mumbai — closest to Indian users
FUNCTION_NAME="ipo-refresh"

echo "==> Deploying Cloud Function to $PROJECT_ID ($REGION)..."

gcloud functions deploy "$FUNCTION_NAME" \
  --gen2 \
  --region="$REGION" \
  --runtime=nodejs18 \
  --entry-point=refresh \
  --trigger-http \
  --allow-unauthenticated \
  --timeout=300s \
  --memory=256Mi \
  --set-env-vars="FIREBASE_PROJECT_ID=${FIREBASE_PROJECT_ID:-},FIREBASE_CLIENT_EMAIL=${FIREBASE_CLIENT_EMAIL:-},FIREBASE_PRIVATE_KEY=${FIREBASE_PRIVATE_KEY:-},ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:-},FIRESTORE_DATABASE_ID=${FIRESTORE_DATABASE_ID:-(default)},REFRESH_SECRET=${REFRESH_SECRET:-}" \
  --source=.

FUNCTION_URL=$(gcloud functions describe "$FUNCTION_NAME" --region="$REGION" --gen2 --format='value(serviceConfig.uri)')
echo ""
echo "==> Function deployed at: $FUNCTION_URL"
echo ""

# Set up Cloud Scheduler (daily at 1:00 AM UTC = 6:30 AM IST)
SCHEDULER_JOB="ipo-daily-refresh"
echo "==> Creating/updating Cloud Scheduler job..."

gcloud scheduler jobs delete "$SCHEDULER_JOB" --location="$REGION" --quiet 2>/dev/null || true

SCHEDULER_URL="$FUNCTION_URL?force=true"
if [ -n "${REFRESH_SECRET:-}" ]; then
  SCHEDULER_URL="$FUNCTION_URL?force=true&key=$REFRESH_SECRET"
fi

gcloud scheduler jobs create http "$SCHEDULER_JOB" \
  --location="$REGION" \
  --schedule="0 1 * * *" \
  --uri="$SCHEDULER_URL" \
  --http-method=GET \
  --time-zone="UTC"

echo ""
echo "==> Done! Scheduler will call $FUNCTION_NAME daily at 1:00 AM UTC."
echo ""
echo "Next steps:"
echo "  1. Set REFRESH_GCF_URL=$FUNCTION_URL in your Vercel env vars"
if [ -n "${REFRESH_SECRET:-}" ]; then
  echo "  2. Set REFRESH_SECRET=$REFRESH_SECRET in your Vercel env vars"
fi
echo "  3. Redeploy Vercel so /api/refresh proxies to the Cloud Function"
echo "  4. Test: curl \"$FUNCTION_URL?force=true${REFRESH_SECRET:+&key=$REFRESH_SECRET}\""
