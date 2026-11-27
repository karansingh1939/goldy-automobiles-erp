import { localDate, monthStart } from '../../shared/utils/local-date.js';
import { DashboardRepository } from './dashboard.repository.js';
import { ProfitService } from '../profit/profit.service.js';
import { InventoryService } from '../inventory/inventory.service.js';
import { optionalDate } from '../../shared/utils/validation.js';

export class DashboardService {
  constructor(db) {
    this.repository = new DashboardRepository(db);
    this.profitService = new ProfitService(db);
    this.inventoryService = new InventoryService(db);
  }

  getOperationsMetrics(todayDate) {
    let date = optionalDate(todayDate, 'Today date');
    if (!date) {
      date = localDate();
    }
    return this.repository.getOperationsMetrics(date);
  }

  getFinancialMetrics(todayDate) {
    let date = optionalDate(todayDate, 'Today date');
    if (!date) {
      date = localDate();
    }

    const todayData = this.profitService.summary({
      period: 'custom',
      dateFrom: date,
      dateTo: date,
    }).data;

    const monthData = this.profitService.summary({
      period: 'custom',
      dateFrom: monthStart(date),
      dateTo: date,
    }).data;

    const outstandingAmount = this.repository.db
      .prepare(
        `
      SELECT COALESCE(SUM(grand_total - amount_paid), 0) AS balance
      FROM (
        SELECT MAX(0, invoices.grand_total - invoices.amount_paid - COALESCE((
          SELECT SUM(total_refund_amount) FROM customer_returns
          WHERE invoice_id = invoices.id AND status = 'COMPLETED' AND company_id = 1
        ), 0)) AS grand_total, 0 AS amount_paid
        FROM invoices WHERE status = 'FINALIZED'
        UNION ALL
        SELECT grand_total, amount_paid FROM direct_invoices
        WHERE status <> 'CANCELLED' AND company_id = 1
      ) sales
    `,
      )
      .get().balance;

    return {
      today: {
        revenue: todayData.totalRevenue,
        grossProfit: todayData.grossProfit,
        netProfit: todayData.netProfit,
      },
      thisMonth: {
        revenue: monthData.totalRevenue,
        expenses: monthData.totalExpenses,
        grossProfit: monthData.grossProfit,
        netProfit: monthData.netProfit,
      },
      outstandingAmount,
    };
  }

  getSalesMetrics(todayDate) {
    let date = optionalDate(todayDate, 'Today date');
    if (!date) {
      date = localDate();
    }

    const todaySummary = this.repository.getSalesSummary(date, date);
    const monthSummary = this.repository.getSalesSummary(monthStart(date), date);

    const invoicesToday = todaySummary.count;
    const invoicesThisMonth = monthSummary.count;
    const totalAmountThisMonth = monthSummary.totalAmount;

    const averageInvoiceValue =
      invoicesThisMonth > 0
        ? Math.round((totalAmountThisMonth / invoicesThisMonth) * 100) / 100
        : 0;

    const topCustomers = this.profitService
      .byCustomer({
        period: 'custom',
        dateFrom: monthStart(date),
        dateTo: date,
      })
      .data.slice(0, 5);

    const topServices = this.repository.getTopServices(5);
    const recentSales = this.repository.getRecentSales(5);

    return {
      summary: {
        invoicesToday,
        invoicesThisMonth,
        averageInvoiceValue,
      },
      topCustomers,
      topServices,
      recentSales,
    };
  }

  getInventoryMetrics() {
    const valuation = this.inventoryService.stockValuation();
    const lowStock = this.inventoryService.lowStockReport();
    const warehouseSummary = this.repository.getWarehouseStockSummary();
    const totalItems = this.repository.getTotalItemCount();

    return {
      totalItems,
      totalQuantity: valuation.totals.quantity,
      totalValuation: valuation.totals.value,
      lowStockCount: lowStock.data.length,
      lowStockItems: lowStock.data.map((item) => ({
        id: item.id,
        sku: item.sku,
        itemName: item.item_name,
        currentQuantity: item.current_quantity,
        reorderLevel: item.reorder_level,
        unitOfMeasure: item.unit_of_measure,
      })),
      warehouseSummary,
    };
  }
}

export function createDashboardService(db) {
  return new DashboardService(db);
}
