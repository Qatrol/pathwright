// Учебная программа: 7 месяцев, 37 тем.
const roadmap = {
  course: 'DevOps с нуля до Lead',
  months: [
    { month: 0, title: 'Месяц 0: Подготовка и фундамент', topics: [
      { id: 'm0-linux-install', title: 'Установка Linux (WSL2 или VM)', description: 'Установка и базовая настройка Linux для разработки', level: 'beginner' },
      { id: 'm0-github', title: 'Настройка GitHub', description: 'Регистрация, создание репозитория, SSH-ключи', level: 'beginner' },
      { id: 'm0-git-install', title: 'Установка Git', description: 'Установка и первичная настройка Git', level: 'beginner' },
      { id: 'm0-docker-install', title: 'Установка Docker', description: 'Установка Docker Desktop и проверка работы', level: 'beginner' }
    ] },
    { month: 1, title: 'Месяц 1: Linux, Git и сети', topics: [
      { id: 'm1-linux-fs', title: 'Файловая система Linux', description: 'Структура каталогов, права доступа, монтирование', level: 'beginner' },
      { id: 'm1-linux-processes', title: 'Процессы и службы', description: 'Управление процессами, systemd, логи', level: 'beginner' },
      { id: 'm1-linux-net', title: 'Сети в Linux', description: 'ip, netstat, firewall, SSH', level: 'beginner' },
      { id: 'm1-git-branch', title: 'Ветвление и слияния', description: 'Branch, merge, rebase, разрешение конфликтов', level: 'beginner' },
      { id: 'm1-git-pr', title: 'Pull Requests', description: 'Работа с PR, code review', level: 'beginner' },
      { id: 'm1-dns', title: 'DNS', description: 'Как работает DNS, типы записей', level: 'beginner' },
      { id: 'm1-tcp-udp', title: 'TCP vs UDP', description: 'Различия, когда что использовать', level: 'beginner' },
      { id: 'm1-http', title: 'HTTP/HTTPS', description: 'Методы, статусы, заголовки, TLS', level: 'beginner' },
      { id: 'm1-lb', title: 'Балансировка нагрузки', description: 'Основы LB, алгоритмы', level: 'beginner' }
    ] },
    { month: 2, title: 'Месяц 2: Docker и контейнеры', topics: [
      { id: 'm2-containers', title: 'Что такое контейнеры', description: 'Контейнеры vs виртуальные машины', level: 'beginner' },
      { id: 'm2-images', title: 'Образы Docker', description: 'Dockerfile, слои, оптимизация', level: 'beginner' },
      { id: 'm2-volumes', title: 'Тома и сети', description: 'Volumes, networks, работа с данными', level: 'beginner' },
      { id: 'm2-multistage', title: 'Многоэтапная сборка', description: 'Multistage build, уменьшение размера образа', level: 'intermediate' }
    ] },
    { month: 3, title: 'Месяц 3: Kubernetes', topics: [
      { id: 'm3-why', title: 'Зачем нужен Kubernetes', description: 'Оркестрация, проблемы, которые решает', level: 'beginner' },
      { id: 'm3-pods', title: 'Поды и Deployments', description: 'Pod, Deployment, ReplicaSet', level: 'intermediate' },
      { id: 'm3-services', title: 'Services и Ingress', description: 'Service, ClusterIP, NodePort, LoadBalancer, Ingress', level: 'intermediate' },
      { id: 'm3-configs', title: 'ConfigMap и Secret', description: 'Управление конфигурацией и секретами', level: 'intermediate' },
      { id: 'm3-troubleshooting', title: 'Устранение неполадок', description: 'CrashLoopBackOff, логи, describe, exec', level: 'intermediate' }
    ] },
    { month: 4, title: 'Месяц 4: CI/CD, облака, IaC', topics: [
      { id: 'm4-cicd-concepts', title: 'Концепции CI/CD', description: 'Build - Test - Deploy, зачем нужен пайплайн', level: 'intermediate' },
      { id: 'm4-actions', title: 'GitHub Actions', description: 'Настройка workflow, сборка Docker, деплой', level: 'intermediate' },
      { id: 'm4-cloud-compute', title: 'Вычисления и сети в облаке', description: 'VPC, подсети, security groups', level: 'intermediate' },
      { id: 'm4-iam', title: 'Основы IAM', description: 'Роли, политики, принцип наименьших привилегий', level: 'intermediate' },
      { id: 'm4-tf-basics', title: 'Основы Terraform', description: 'Провайдеры, ресурсы, состояние', level: 'intermediate' },
      { id: 'm4-tf-state', title: 'Terraform State и Backend', description: 'Управление состоянием, блокировки, remote backend', level: 'advanced' }
    ] },
    { month: 5, title: 'Месяц 5: Мониторинг, GitOps, безопасность', topics: [
      { id: 'm5-prometheus', title: 'Prometheus', description: 'Метрики, экспортеры, PromQL', level: 'intermediate' },
      { id: 'm5-grafana', title: 'Grafana', description: 'Дашборды, алерты', level: 'intermediate' },
      { id: 'm5-argo', title: 'ArgoCD', description: 'Git как источник истины, синхронизация, откат', level: 'advanced' },
      { id: 'm5-sec-iam', title: 'IAM и управление секретами', description: 'Least privilege, Vault, sealed secrets', level: 'advanced' },
      { id: 'm5-sec-net', title: 'Сетевая безопасность', description: 'Firewall, WAF, DDoS-защита', level: 'advanced' }
    ] },
    { month: 6, title: 'Месяц 6: Проекты и подготовка к работе', topics: [
      { id: 'm6-proj-cicd', title: 'Комплексный CI/CD проект', description: 'Полный пайплайн от кода до продакшена', level: 'advanced' },
      { id: 'm6-proj-k8s', title: 'Проект развёртывания в Kubernetes', description: 'Микросервисы, масштабирование, мониторинг', level: 'advanced' },
      { id: 'm6-proj-tf', title: 'Проект инфраструктуры Terraform', description: 'Создание облачной инфраструктуры кодом', level: 'advanced' },
      { id: 'm6-interview', title: 'Подготовка к собеседованию', description: 'Типовые вопросы, разбор кейсов, soft skills', level: 'advanced' }
    ] }
  ]
};

const topicIndex = new Map();
for (const m of roadmap.months) {
  for (const t of m.topics) topicIndex.set(t.id, t);
}

module.exports = { roadmap, topicIndex };
