# Oracle Production Host

## OS

- OS: Ubuntu 24.04.4 LTS (Noble Numbat)
- Architecture: aarch64 (ARM64)
- Kernel: 6.17.0-1011-oracle

## Hostname

- instance-20260415-1437

## Deployment

### Docker Compose

- Project path: `/home/ubuntu/modelwiki/docker`
- Compose config: `/home/ubuntu/modelwiki/docker/docker-compose.yml`

### Containers

| Container | Image | Port |
|-----------|-------|------|
| mw-api | docker-api (local build) | 127.0.0.1:3001→3000 |
| mw-wordpress | wordpress:6-php8.2-fpm-alpine | 127.0.0.1:9000 |
| mw-postgres | postgres:16-alpine | 5432 |
| mw-redis | redis:7-alpine | 6379 |
| mw-mysql | mysql:8.0 | 3306 |
| mw-imgproxy | darthsim/imgproxy:v3 | 127.0.0.1:8081→8080 |

### Nginx

- Config path: `/www/server/panel/vhost/nginx/www.phoebusstudio.com.conf`
- WordPress root: `/var/lib/docker/volumes/docker_wp_data/_data`
- Admin path: `/admin/` → `page-admin.php` (theme)
- Legacy admin path: `/guanli/` → `guanli/index.php`

### Paths

- ORACLE_REPO_PATH: `/home/ubuntu/modelwiki/docker` (no git)
- WORDPRESS_ROOT: `/var/lib/docker/volumes/docker_wp_data/_data`
- ACTIVE_THEME_PATH: `/home/ubuntu/modelwiki/docker/wordpress/wp-content/themes/modelwiki`
- BACKEND_COMPOSE_PATH: `/home/ubuntu/modelwiki/docker`
- BACKEND_CONTAINER: mw-api
- API_SOURCE_PATH: `/home/ubuntu/modelwiki/docker/api`

### Current Git SHA

- No git repository on Oracle production
- GitHub recovery branch SHA: `9b608524d7b5a052804d5f3c0ae2cc900f7a4c93`
