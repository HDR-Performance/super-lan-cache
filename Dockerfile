FROM node:24-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e AS node-runtime
FROM lancachenet/ubuntu-nginx:latest@sha256:3288a9554a2025b51fd54ed5b3d9a798c81f21fe60d0e72db8fe2b29c03b5412
LABEL version=3
LABEL description="Super Lan-Cache: integrated game cache engine, live dashboard and management."
LABEL org.opencontainers.image.source="https://github.com/HDR-Performance/super-lan-cache"

RUN	apt-get update							;\
	apt-get install -y jq git libstdc++6				;

ENV GENERICCACHE_VERSION=2 \
    CACHE_MODE=monolithic \
    WEBUSER=www-data \
    CACHE_INDEX_SIZE=500m \
    CACHE_DISK_SIZE=1000g \
    MIN_FREE_DISK=10g \
    CACHE_MAX_AGE=3560d \
    CACHE_SLICE_SIZE=1m \
    UPSTREAM_DNS="8.8.8.8 8.8.4.4" \
    BEAT_TIME=1h \
    LOGFILE_RETENTION=3560 \
    CACHE_DOMAINS_REPO="https://github.com/uklans/cache-domains.git" \
    CACHE_DOMAINS_BRANCH=master \
    NGINX_WORKER_PROCESSES=auto \
    NGINX_LOG_FORMAT=cachelog

COPY vendor/monolithic/overlay/ /

RUN rm /etc/nginx/sites-enabled/* /etc/nginx/stream-enabled/* ;\
    rm /etc/nginx/conf.d/gzip.conf ;\
    chmod 754  /var/log/tallylog ; \
    id -u ${WEBUSER} &> /dev/null || adduser --system --home /var/www/ --no-create-home --shell /bin/false --group --disabled-login ${WEBUSER} ;\
    chmod 755 /scripts/*		;\
	  mkdir -m 755 -p /data/cache		;\
	  mkdir -m 755 -p /data/info		;\
    mkdir -m 755 -p /data/logs		;\
    mkdir -m 755 -p /tmp/nginx/		;\
    chown -R ${WEBUSER}:${WEBUSER} /data/	;\
    mkdir -p /etc/nginx/sites-enabled	;\
    ln -s /etc/nginx/sites-available/10_cache.conf /etc/nginx/sites-enabled/10_generic.conf; \
    ln -s /etc/nginx/sites-available/20_upstream.conf /etc/nginx/sites-enabled/20_upstream.conf; \
    ln -s /etc/nginx/sites-available/30_metrics.conf /etc/nginx/sites-enabled/30_metrics.conf; \
    ln -s /etc/nginx/stream-available/10_sni.conf /etc/nginx/stream-enabled/10_sni.conf; \
    mkdir -m 755 -p /data/cachedomains		;\
    mkdir -m 755 -p /tmp/nginx

COPY vendor/cache-domains/ /data/cachedomains/
RUN git init /data/cachedomains

VOLUME ["/data/logs", "/data/cache", "/data/cachedomains", "/var/www"]

EXPOSE 80 443 8080
WORKDIR /scripts

HEALTHCHECK --interval=1m --timeout=1s --start-period=120s --retries=3 CMD curl --fail http://127.0.0.1/lancache-heartbeat  || exit 1

COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY package.json /opt/lancache-gui/package.json
COPY server/ /opt/lancache-gui/server/
COPY public/ /opt/lancache-gui/public/
COPY vendor/ /opt/lancache-gui/vendor/
COPY deploy/gui.conf /etc/supervisor/conf.d/gui.conf
COPY deploy/nginx.conf /etc/supervisor/conf.d/nginx.conf
COPY deploy/gui-control.conf /etc/supervisor/gui-control.conf
COPY deploy/99_gui_settings.sh /hooks/entrypoint-pre.d/99_gui_settings.sh
COPY deploy/20_perms_check.sh /hooks/entrypoint-pre.d/20_perms_check.sh
COPY deploy/healthcheck.sh /scripts/gui-healthcheck.sh
RUN find /hooks /scripts -type f -name '*.sh' -exec sed -i 's/\r$//' {} + && \
    find /hooks /scripts -type f -name '*.sh' -exec chmod 755 {} + && \
    find /etc/nginx /opt/lancache-gui/vendor -type f -name '*.conf' -exec sed -i 's/\r$//' {} + && mkdir -p /data/manager
ENV GUI_MANAGED=true GUI_PORT=20722 GUI_DATA=/data/manager NOFETCH=true
EXPOSE 20722
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 CMD /scripts/gui-healthcheck.sh
LABEL org.opencontainers.image.title="Super Lan-Cache" org.opencontainers.image.version="0.1.2"
