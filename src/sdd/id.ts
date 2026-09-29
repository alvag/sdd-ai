const ID = /^[A-Za-z0-9._-]{1,128}$/

/** Un id es un solo segmento de ruta: con eso cada flujo tiene una sola identidad bajo `.plans/`. */
export const isFlowId = (id: string) => ID.test(id) && id !== '.' && id !== '..'
