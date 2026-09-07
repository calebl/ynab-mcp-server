FROM node:lts-alpine

# Create app directory
WORKDIR /app

# Install app dependencies
COPY package*.json ./
RUN npm install --ignore-scripts

# Copy the rest of the code
COPY . .

# Build the project
RUN npm run build

# Expose any port if required (not strictly necessary for stdio based MCP)

# Set environment variable placeholder (user should override these values in production)
ENV YNAB_API_TOKEN=""
# optional:
# ENV YNAB_BUDGET_ID=""

# Define the command to run your app using node
CMD ["node", "dist/index.js"]
