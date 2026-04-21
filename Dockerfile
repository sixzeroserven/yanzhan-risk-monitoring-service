FROM public.ecr.aws/docker/library/node:20-alpine

WORKDIR /app

RUN apk add --no-cache python3 py3-pip
RUN python3 -m venv /opt/pyenv
ENV PATH="/opt/pyenv/bin:${PATH}"

COPY package.json ./
COPY tsconfig.json tsconfig.build.json ./
COPY prisma ./prisma
COPY src ./src
COPY jobs ./jobs

RUN pip install --no-cache-dir -r jobs/requirements.txt && \
    npm install && \
    npm run prisma:generate && \
    npm run build && \
    npm prune --omit=dev

EXPOSE 3000

CMD ["npm", "start"]
