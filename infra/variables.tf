# =============================================
# OVH Public Cloud / OpenStack credentials
# Create in: OVH Manager → Public Cloud → Users & Roles
# =============================================
variable "ovh_project_id" {
  type        = string
  description = "Public Cloud project ID (visible in OVH Manager URL)"
}

variable "openstack_username" {
  type      = string
  sensitive = true
}

variable "openstack_password" {
  type      = string
  sensitive = true
}

# =============================================
# Server configuration
# =============================================
variable "ssh_public_key" {
  type        = string
  description = "Contents of your public key (e.g., ssh-ed25519 AAAA...)"
}

variable "allowed_ssh_cidr" {
  type        = string
  default     = "0.0.0.0/0"
  description = "CIDR to allow SSH from — restrict to your IP (e.g., 86.123.45.67/32)"
}

variable "flavor_name" {
  type        = string
  default     = "d2-2"
  description = "OVH instance flavor: d2-2 (2 vCPU, 4GB RAM) is the recommended minimum"
}

variable "region" {
  type        = string
  default     = "GRA9"
  description = "OVH region: GRA9 (Gravelines), SBG5 (Strasbourg), UK1 (London)"
}

# =============================================
# Application configuration
# =============================================
variable "domain" {
  type        = string
  description = "Domain name pointing to this server (e.g., reader.yourdomain.com)"
}

variable "basic_auth_hash" {
  type        = string
  sensitive   = true
  description = "Bcrypt hash of the app password (built-in auth SETTINGS_AUTH_HASH) — generate with: npx bcryptjs 'yourpassword' or caddy hash-password --plaintext 'yourpassword'"
}

variable "settings_encryption_key" {
  type        = string
  sensitive   = true
  description = "AES-256-GCM key for encrypted settings (64 hex chars) — generate with: openssl rand -hex 32"
}

variable "anthropic_api_key" {
  type      = string
  sensitive = true
}

variable "jina_api_key" {
  type        = string
  sensitive   = true
  default     = ""
  description = "Jina Reader API key for article fetching (leave empty to use free tier)"
}


variable "betterstack_source_token" {
  type        = string
  default     = ""
  sensitive   = true
  description = "Better Stack source token for log shipping (leave empty to disable)"
}

variable "github_image" {
  type        = string
  default     = ""
  description = "GHCR image path (e.g., ghcr.io/youruser/glenary:latest). Leave empty for first deploy."
}
