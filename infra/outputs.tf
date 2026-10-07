output "server_ip" {
  value       = openstack_compute_instance_v2.app.access_ip_v4
  description = "Public IPv4 address of the server"
}

output "ssh_command" {
  value       = "ssh -i ~/.ssh/<path-to-your-private-key> ubuntu@${openstack_compute_instance_v2.app.access_ip_v4}"
  description = "SSH command to connect to the server"
}

output "app_url" {
  value       = "https://${var.domain}"
  description = "Application URL (will work after DNS propagation)"
}

output "health_check" {
  value       = "curl -u reader:PASSWORD https://${var.domain}/api/health" # gitleaks:allow (placeholder)
  description = "Health check command (replace PASSWORD with your basic auth password)"
}
