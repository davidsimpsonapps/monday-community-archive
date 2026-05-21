# Install wrangler if needed
npm install -g wrangler
wrangler login

# Create the bucket
wrangler r2 bucket create monday-community-archive-api

# Get R2 credentials from Cloudflare dashboard → R2 → Manage R2 API tokens
#.   here: https://dash.cloudflare.com/9e843a085416a1fc2f2cbd252c6d4bdf/r2/api-tokens

# Then configure rclone:
# rclone config create r2 s3 \
#   provider=Cloudflare \
#   access_key_id=abc123yourkeyid \
#   secret_access_key=xyz789yoursecretkey \
#   endpoint=https://a1b2c3d4e5f6youraccount.r2.cloudflarestorage.com


# Sync api files
rclone sync dist/api/ r2:monday-community-archive-api/api/

