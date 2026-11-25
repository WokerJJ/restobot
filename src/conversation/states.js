// Estados de la conversación y límites compartidos por flow.js e interpret.js.

export const STATES = Object.freeze({
  INICIO: 'inicio',
  SALUDO: 'saludo',
  MENU: 'menu',
  CANTIDAD: 'cantidad',
  CARRITO: 'carrito',
  ZONA: 'zona',
  DIRECCION: 'direccion',
  PAGO: 'pago',
  CONFIRMACION: 'confirmacion',
  HUMANO: 'humano'
});

export const MAX_QTY = 50;
