terraform {
  required_providers {
    openstack = {
      source  = "terraform-provider-openstack/openstack"
      version = "~> 3.0"
    }
  }
}

provider "openstack" {
  auth_url    = "https://auth.cloud.ovh.net/v3"
  domain_name = "Default"
  tenant_id   = var.ovh_project_id
  user_name   = var.openstack_username
  password    = var.openstack_password
  region      = var.region
}

# --- SSH Key ---
resource "openstack_compute_keypair_v2" "default" {
  name       = "gleanary"
  public_key = var.ssh_public_key

  # The live keypair predates the app rename (still "readwise-clone"), and a
  # name change forces replacement, which would cascade to the instance.
  lifecycle {
    ignore_changes = [name]
  }
}

# --- VPS Instance ---
# NOTE: No explicit security_groups — OpenStack auto-assigns "default".
# OVH will recreate the default security group with open ingress rules.
resource "openstack_compute_instance_v2" "app" {
  name        = "gleanary"
  image_name  = "Ubuntu 24.04"
  flavor_name = var.flavor_name
  region      = var.region
  key_pair    = openstack_compute_keypair_v2.default.name

  user_data = templatefile("cloud-init.yml", {
    domain                  = var.domain
    basic_auth_hash         = var.basic_auth_hash
    settings_encryption_key = var.settings_encryption_key
    anthropic_api_key       = var.anthropic_api_key
    jina_api_key            = var.jina_api_key
    betterstack_token       = var.betterstack_source_token
    sentry_dsn              = var.sentry_dsn
    github_image            = var.github_image
  })

  network {
    name = "Ext-Net"
  }

  # Replacing the instance wipes its local disk (the SQLite DB) and changes
  # the public IP. These attributes all force replacement, so drift on them is
  # ignored: name/key_pair predate the app rename, image_name no longer
  # resolves ("Image not found"), and user_data only runs at first boot.
  # Runtime config/secret changes go to the server's env file over SSH; to
  # re-bootstrap from cloud-init.yml on purpose, use `tofu apply -replace`.
  lifecycle {
    ignore_changes = [name, key_pair, image_name, user_data]
  }
}
