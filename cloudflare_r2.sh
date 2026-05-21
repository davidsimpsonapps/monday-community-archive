# Install wrangler if needed
npm install -g wrangler
wrangler login

# Create the bucket
wrangler r2 bucket create monday-community-archive-api

# Get R2 credentials from Cloudflare dashboard → R2 → Manage R2 API tokens
# Then configure rclone:
rclone config  # add remote: type=s3, provider=Cloudflare, access_key_id/secret from above
#   endpoint: https://<account_id>.r2.cloudflarestorage.com

# Sync api files
rclone sync dist/api/ r2:monday-community-archive-api/api/
