// Реестр «запрос уже выполняется» — чтобы не генерировать один и тот же урок дважды.
const inFlight = new Map();
module.exports = { inFlight };
