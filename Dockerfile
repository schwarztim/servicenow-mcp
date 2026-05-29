FROM mcr.microsoft.com/playwright:v1.52.0-noble
RUN apt-get update && apt-get install -y --no-install-recommends dumb-init libsecret-1-dev build-essential python3 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json node-vault-mcp-1.0.0.tgz ./
RUN sed -i 's|"node-vault-mcp": "file:[^"]*"|"node-vault-mcp": "file:./node-vault-mcp-1.0.0.tgz"|' package.json \
    && npm install --legacy-peer-deps --ignore-scripts \
    && npm cache clean --force \
    && rm -f node-vault-mcp-1.0.0.tgz
COPY dist ./dist
COPY nscacert.pem /usr/local/share/ca-certificates/nscacert.crt
RUN update-ca-certificates
ENV NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/nscacert.crt
ENV NODE_ENV=production
ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["node", "dist/index.js"]
