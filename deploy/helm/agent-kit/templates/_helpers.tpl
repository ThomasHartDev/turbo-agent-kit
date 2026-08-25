{{- define "agent-kit.name" -}}
{{- default .Chart.Name .Values.nameOverride | lower | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- define "agent-kit.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | lower | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- .Release.Name }}-{{ include "agent-kit.name" . }}
{{- end }}
{{- end }}
