FROM node:20-alpine

RUN apk add --no-cache dnsmasq iptables iproute2

WORKDIR /opt/computerd/gateway-runtime

COPY entrypoint.mjs /opt/computerd/gateway-runtime/entrypoint.mjs

RUN mkdir -p /etc/computerd /var/run/computerd-gateway

CMD ["node", "/opt/computerd/gateway-runtime/entrypoint.mjs"]
