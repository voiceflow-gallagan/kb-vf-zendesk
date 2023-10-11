# Specify the node base image with your desired version
FROM node:18

# Set the working directory in the Docker image
WORKDIR /usr/src/app

# Install git
RUN apt-get update && \
    apt-get upgrade -y

# Install PM2 globally in the image
RUN npm install pm2 -g

# Copy package.json and package-lock.json
COPY package*.json ./

# Install app dependencies
RUN npm install

# Define the command to run your app using PM2
CMD [ "pm2-runtime", "start", "app.js" ]
