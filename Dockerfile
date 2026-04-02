FROM node:20-slim
RUN npm install -g mcp-proxy
CMD ["mcp-proxy", "https://headlessoracle.com/mcp"]
