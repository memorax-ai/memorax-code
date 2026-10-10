ARG NODE_IMAGE
FROM ${NODE_IMAGE}
ARG NODE_MAJOR

RUN sed -i 's|http://deb.debian.org/|https://deb.debian.org/|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get -o Acquire::Retries=3 update \
    && apt-get -o Acquire::Retries=3 install -y --no-install-recommends \
       xvfb xauth dbus libgtk-3-0 libnss3 libgbm1 libasound2 libxss1 \
       libsecret-1-0 libx11-xcb1 libxkbfile1 fonts-liberation ca-certificates \
       libcurl4 libudev1 xdg-utils \
    && rm -rf /var/lib/apt/lists/*

COPY cursor.deb /tmp/cursor.deb
ARG CURSOR_DEB_VERSION
ARG CURSOR_APP_VERSION
RUN test "$(dpkg-deb --field /tmp/cursor.deb Package)" = cursor \
    && test "$(dpkg-deb --field /tmp/cursor.deb Version)" = "$CURSOR_DEB_VERSION" \
    && test "$(dpkg-deb --field /tmp/cursor.deb Architecture)" = "$(dpkg --print-architecture)" \
    && dpkg-deb --extract /tmp/cursor.deb /opt/cursor-app \
    && rm /tmp/cursor.deb \
    && node -e 'const p=require("/opt/cursor-app/usr/share/cursor/resources/app/package.json"), [major,minor]=process.versions.node.split(".").map(Number); if(p.version!==process.env.CURSOR_APP_VERSION||!["22","24"].includes(process.env.NODE_MAJOR)||String(major)!==process.env.NODE_MAJOR||(major===22&&minor<13)) process.exit(1)'

RUN npm install --prefix /opt/probe --ignore-scripts --no-audit --no-fund --package-lock=false \
       --registry=https://registry.npmjs.org/ playwright-core@1.58.2
COPY candidate.tgz /tmp/candidate.tgz
RUN npm install --prefix /opt/candidate --ignore-scripts --no-audit --no-fund --package-lock=false \
       --registry=https://registry.npmjs.org/ /tmp/candidate.tgz \
    && rm /tmp/candidate.tgz
COPY check/ /opt/check/
RUN mkdir /artifacts && chown node:node /artifacts

USER node
WORKDIR /tmp
ENV HOME=/tmp/cursor-home
