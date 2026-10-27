# Public gateway for Render: routes /api/* to the private services, exposes only the
# Paystack webhook, blocks /internal/*. Config comes from the template + env vars.
FROM nginx:1.27-alpine
COPY default.conf.template /etc/nginx/templates/default.conf.template

# Makes the official image export NGINX_LOCAL_RESOLVERS (the platform's DNS server)
# so the template can re-resolve private hostnames instead of caching them forever.
ENV NGINX_ENTRYPOINT_LOCAL_RESOLVERS=1
EXPOSE 10000
