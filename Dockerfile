FROM node:8.11

WORKDIR "/caliper"

# Install app dependencies
# A wildcard is used to ensure both package.json AND package-lock.json are copied
# where available (npm@5+)
COPY package*.json ./

RUN npm install

# Bundle app source
COPY ./src ./src

CMD ["npm", "start"]