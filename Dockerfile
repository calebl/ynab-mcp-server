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

# The default runtime now starts the authless HTTP server on port 3000.

# Set environment variable placeholder (override in production)
ENV YNAB_API_TOKEN=""
# optional:
# ENV YNAB_PLAN_ID=""

# Define the command to run the default HTTP server
CMD ["node", "dist/index.js"]
