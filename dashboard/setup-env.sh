#!/bin/bash

# Run this once to create your .env.local with your Firebase config.
# Find these values in: Firebase Console > Project Settings > Your apps > SDK setup

echo ""
echo "========================================="
echo "  Oberlin Dashboard — Environment Setup  "
echo "========================================="
echo ""
echo "Paste each value from your Firebase project config."
echo "Leave blank and press Enter to skip (you can edit .env.local manually later)."
echo ""

read -p "NEXT_PUBLIC_FIREBASE_API_KEY:            " api_key
read -p "NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN:        " auth_domain
read -p "NEXT_PUBLIC_FIREBASE_PROJECT_ID:         " project_id
read -p "NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET:     " storage_bucket
read -p "NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID:" messaging_sender
read -p "NEXT_PUBLIC_FIREBASE_APP_ID:             " app_id
read -p "NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID:     " measurement_id

cat > .env.local <<EOF
NEXT_PUBLIC_FIREBASE_API_KEY=$api_key
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=$auth_domain
NEXT_PUBLIC_FIREBASE_PROJECT_ID=$project_id
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=$storage_bucket
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=$messaging_sender
NEXT_PUBLIC_FIREBASE_APP_ID=$app_id
NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID=$measurement_id
EOF

echo ""
echo ".env.local created successfully."
echo "Never commit this file — it is already in .gitignore."
echo ""
