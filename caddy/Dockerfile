FROM caddy:2-alpine

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

COPY Caddyfile /etc/caddy/Caddyfile

ENTRYPOINT ["/entrypoint.sh"]
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
