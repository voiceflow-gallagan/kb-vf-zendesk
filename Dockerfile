# Specify the node base image with your desired version
FROM node:18

# Set the working directory in the Docker image
WORKDIR /usr/src/app

# Install git
RUN apt-get update && \
    apt-get upgrade -y && \
    apt-get install -y git

# Clone your repository
RUN git clone https://github.com/voiceflow-gallagan/kb-vf-zendesk.git .

# Install PM2 globally in the image
RUN npm install pm2 -g

# Install app dependencies
RUN npm install

# Define the command to run your app using PM2
CMD [ "pm2-runtime", "start", "app.js" ]
