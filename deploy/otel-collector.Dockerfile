FROM otel/opentelemetry-collector-contrib:0.128.0 AS collector

FROM alpine:3.21
RUN apk add --no-cache wget ca-certificates \
 && addgroup -g 10001 otel \
 && adduser -D -H -u 10001 -G otel otel
COPY --from=collector /otelcol-contrib /otelcol-contrib
COPY otel-collector.yaml /etc/otelcol-contrib/config.yaml
USER 10001:10001
EXPOSE 4317 4318 13133
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=8 \
    CMD wget -qO- http://127.0.0.1:13133/ || exit 1
ENTRYPOINT ["/otelcol-contrib"]
CMD ["--config", "/etc/otelcol-contrib/config.yaml"]
