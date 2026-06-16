FROM node:20-alpine

WORKDIR /app

# node-adodb (Access/Windows) is an optionalDependency and is skipped on Linux.
# Only pg and express are needed for cloud postgres mode.
COPY package*.json ./
RUN npm ci --only=production --ignore-scripts

COPY src ./src
COPY scripts ./scripts

# PORT is set by fly.toml env to 8080
EXPOSE 8080

CMD ["node", "src/server.js"]
