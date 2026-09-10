// Los 6 reportes del core ERP (pedido explícito: "6 reportes super
// necesarios" estructurados como NetSuite/Oracle EBS). Cada función regresa
// datos ya listos para pintar, la ruta en server.js solo arma los
// parámetros (fechas, moneda) y renderiza la vista.
//
// Moneda: como el tipo de cambio de cada transacción es manual/informativo
// (no hay conversión automática — ver services/erpExchangeRate.js), estos
// reportes NO inventan una conversión: el filtro de moneda simplemente
// enseña los montos agrupados POR moneda (para comparar peras con peras) o
// filtra a una sola moneda si el negocio quiere ver solo esas operaciones.
const { pool } = require("../db/db");

// 1) Estado de resultados (P&L): ingresos - costos - gastos, en un rango de
// fechas, a partir de las Pólizas de diario (Contabilidad > Pólizas). Si el
// negocio todavía no captura pólizas, regresa todo en ceros (no truena).
async function estadoDeResultados(businessId, from, to) {
  const { rows } = await pool.query(
    `SELECT coa.account_type, coa.code, coa.name,
            COALESCE(SUM(jel.debit), 0)::numeric AS total_debit,
            COALESCE(SUM(jel.credit), 0)::numeric AS total_credit
       FROM erp_chart_of_accounts coa
       JOIN erp_journal_entry_lines jel ON jel.account_id = coa.id
       JOIN erp_journal_entries je ON je.id = jel.journal_entry_id
      WHERE coa.business_id = $1 AND je.entry_date BETWEEN $2 AND $3
        AND coa.account_type IN ('ingreso', 'costo', 'gasto')
      GROUP BY coa.account_type, coa.code, coa.name
      ORDER BY coa.account_type, coa.code`,
    [businessId, from, to]
  );

  const lines = rows.map((r) => {
    const debit = Number(r.total_debit);
    const credit = Number(r.total_credit);
    // Ingreso crece con abono; costo/gasto crecen con cargo.
    const balance = r.account_type === "ingreso" ? credit - debit : debit - credit;
    return { ...r, balance };
  });

  const ingresos = lines.filter((l) => l.account_type === "ingreso");
  const costos = lines.filter((l) => l.account_type === "costo");
  const gastos = lines.filter((l) => l.account_type === "gasto");
  const totalIngresos = ingresos.reduce((sum, l) => sum + l.balance, 0);
  const totalCostos = costos.reduce((sum, l) => sum + l.balance, 0);
  const totalGastos = gastos.reduce((sum, l) => sum + l.balance, 0);
  const utilidadBruta = totalIngresos - totalCostos;
  const utilidadNeta = utilidadBruta - totalGastos;

  return { ingresos, costos, gastos, totalIngresos, totalCostos, totalGastos, utilidadBruta, utilidadNeta };
}

// 2) Balance general (Balance Sheet): saldo acumulado de activo/pasivo/
// capital a una fecha de corte (todas las pólizas con entry_date <= asOf).
// La utilidad del periodo (ingresos - costos - gastos acumulados, que en un
// sistema con cierre contable formal ya estaría reclasificada a capital) se
// muestra aparte para que el balance sí cuadre, dejando explícito que este
// primer paso no hace cierre de ejercicio automático.
async function balanceGeneral(businessId, asOf) {
  const { rows } = await pool.query(
    `SELECT coa.account_type, coa.code, coa.name,
            COALESCE(SUM(jel.debit), 0)::numeric AS total_debit,
            COALESCE(SUM(jel.credit), 0)::numeric AS total_credit
       FROM erp_chart_of_accounts coa
       JOIN erp_journal_entry_lines jel ON jel.account_id = coa.id
       JOIN erp_journal_entries je ON je.id = jel.journal_entry_id
      WHERE coa.business_id = $1 AND je.entry_date <= $2
      GROUP BY coa.account_type, coa.code, coa.name
      ORDER BY coa.account_type, coa.code`,
    [businessId, asOf]
  );

  const lines = rows.map((r) => {
    const debit = Number(r.total_debit);
    const credit = Number(r.total_credit);
    const balance = r.account_type === "activo" ? debit - credit : credit - debit;
    return { ...r, balance };
  });

  const activos = lines.filter((l) => l.account_type === "activo");
  const pasivos = lines.filter((l) => l.account_type === "pasivo");
  const capital = lines.filter((l) => l.account_type === "capital");
  const totalActivo = activos.reduce((sum, l) => sum + l.balance, 0);
  const totalPasivo = pasivos.reduce((sum, l) => sum + l.balance, 0);
  const totalCapitalCapturado = capital.reduce((sum, l) => sum + l.balance, 0);

  // Utilidad acumulada de TODO el historial hasta asOf (no solo del periodo)
  // para que activo = pasivo + capital + utilidad acumulada cuadre.
  const pnl = await estadoDeResultados(businessId, "2000-01-01", asOf);
  const utilidadAcumulada = pnl.utilidadNeta;
  const totalCapital = totalCapitalCapturado + utilidadAcumulada;

  return { activos, pasivos, capital, totalActivo, totalPasivo, totalCapitalCapturado, utilidadAcumulada, totalCapital };
}

// 3) Ventas por cliente: facturas de venta (no canceladas) en un rango de
// fechas, agrupadas por cliente. currency: "" = agrupa también por moneda
// (para comparar peras con peras); un código = filtra solo esa moneda.
async function ventasPorCliente(businessId, from, to, currency) {
  const params = [businessId, from, to];
  let currencyFilter = "";
  if (currency) {
    params.push(currency);
    currencyFilter = ` AND COALESCE(t.currency_code, 'BASE') = $${params.length}`;
  }
  const { rows } = await pool.query(
    `SELECT COALESCE(c.name, t.entity_name_snapshot, 'Sin cliente') AS cliente,
            COALESCE(t.currency_code, 'BASE') AS moneda,
            COUNT(*)::int AS num_facturas,
            COALESCE(SUM(t.total), 0)::numeric AS total_facturado
       FROM erp_transactions t
       LEFT JOIN erp_clients c ON c.id = t.client_id
      WHERE t.business_id = $1 AND t.doc_type = 'factura_venta' AND t.status != 'cancelada'
        AND t.created_at::date BETWEEN $2 AND $3
        ${currencyFilter}
      GROUP BY cliente, moneda
      ORDER BY total_facturado DESC`,
    params
  );
  return rows;
}

// 4) Compras por proveedor: espejo exacto de "Ventas por cliente" pero con
// facturas de compra y proveedores.
async function comprasPorProveedor(businessId, from, to, currency) {
  const params = [businessId, from, to];
  let currencyFilter = "";
  if (currency) {
    params.push(currency);
    currencyFilter = ` AND COALESCE(t.currency_code, 'BASE') = $${params.length}`;
  }
  const { rows } = await pool.query(
    `SELECT COALESCE(v.name, t.entity_name_snapshot, 'Sin proveedor') AS proveedor,
            COALESCE(t.currency_code, 'BASE') AS moneda,
            COUNT(*)::int AS num_facturas,
            COALESCE(SUM(t.total), 0)::numeric AS total_comprado
       FROM erp_transactions t
       LEFT JOIN erp_vendors v ON v.id = t.vendor_id
      WHERE t.business_id = $1 AND t.doc_type = 'factura_compra' AND t.status != 'cancelada'
        AND t.created_at::date BETWEEN $2 AND $3
        ${currencyFilter}
      GROUP BY proveedor, moneda
      ORDER BY total_comprado DESC`,
    params
  );
  return rows;
}

// 5) Cuentas por cobrar (AR): saldo pendiente por cliente = facturado (no
// cancelado) - pagado, solo clientes con saldo > 0. currency filtra tanto
// las facturas como los pagos a esa moneda antes de restar.
async function cuentasPorCobrar(businessId, currency) {
  const params = [businessId];
  let currencyFilterInvoices = "";
  let currencyFilterPayments = "";
  if (currency) {
    params.push(currency);
    currencyFilterInvoices = ` AND COALESCE(t.currency_code, 'BASE') = $${params.length}`;
    currencyFilterPayments = ` AND COALESCE(p.currency_code, 'BASE') = $${params.length}`;
  }
  const { rows } = await pool.query(
    `SELECT c.id, c.name AS cliente,
            COALESCE(inv.total_facturado, 0)::numeric AS total_facturado,
            COALESCE(pay.total_pagado, 0)::numeric AS total_pagado,
            (COALESCE(inv.total_facturado, 0) - COALESCE(pay.total_pagado, 0))::numeric AS saldo
       FROM erp_clients c
       LEFT JOIN (
         SELECT t.client_id, SUM(t.total) AS total_facturado
           FROM erp_transactions t
          WHERE t.business_id = $1 AND t.doc_type = 'factura_venta' AND t.status != 'cancelada'
            ${currencyFilterInvoices}
          GROUP BY t.client_id
       ) inv ON inv.client_id = c.id
       LEFT JOIN (
         SELECT p.client_id, SUM(p.amount) AS total_pagado
           FROM erp_customer_payments p
          WHERE p.business_id = $1 ${currencyFilterPayments}
          GROUP BY p.client_id
       ) pay ON pay.client_id = c.id
      WHERE c.business_id = $1
        AND (COALESCE(inv.total_facturado, 0) - COALESCE(pay.total_pagado, 0)) > 0.005
      ORDER BY saldo DESC`,
    params
  );
  return rows;
}

// 6) Cuentas por pagar (AP): espejo de Cuentas por cobrar con proveedores.
async function cuentasPorPagar(businessId, currency) {
  const params = [businessId];
  let currencyFilterInvoices = "";
  let currencyFilterPayments = "";
  if (currency) {
    params.push(currency);
    currencyFilterInvoices = ` AND COALESCE(t.currency_code, 'BASE') = $${params.length}`;
    currencyFilterPayments = ` AND COALESCE(p.currency_code, 'BASE') = $${params.length}`;
  }
  const { rows } = await pool.query(
    `SELECT v.id, v.name AS proveedor,
            COALESCE(inv.total_facturado, 0)::numeric AS total_facturado,
            COALESCE(pay.total_pagado, 0)::numeric AS total_pagado,
            (COALESCE(inv.total_facturado, 0) - COALESCE(pay.total_pagado, 0))::numeric AS saldo
       FROM erp_vendors v
       LEFT JOIN (
         SELECT t.vendor_id, SUM(t.total) AS total_facturado
           FROM erp_transactions t
          WHERE t.business_id = $1 AND t.doc_type = 'factura_compra' AND t.status != 'cancelada'
            ${currencyFilterInvoices}
          GROUP BY t.vendor_id
       ) inv ON inv.vendor_id = v.id
       LEFT JOIN (
         SELECT p.vendor_id, SUM(p.amount) AS total_pagado
           FROM erp_vendor_payments p
          WHERE p.business_id = $1 ${currencyFilterPayments}
          GROUP BY p.vendor_id
       ) pay ON pay.vendor_id = v.id
      WHERE v.business_id = $1
        AND (COALESCE(inv.total_facturado, 0) - COALESCE(pay.total_pagado, 0)) > 0.005
      ORDER BY saldo DESC`,
    params
  );
  return rows;
}

module.exports = {
  estadoDeResultados,
  balanceGeneral,
  ventasPorCliente,
  comprasPorProveedor,
  cuentasPorCobrar,
  cuentasPorPagar,
};
